const express = require("express");
const crypto = require("crypto");

/**
 * Shopify mandatory GDPR webhook handlers.
 * Required for App Store submission.
 * See: https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks
 */
function createWebhookRouter({ config }) {
  const router = express.Router();

  // Use raw body for HMAC verification
  router.use(express.raw({ type: "application/json" }));

  // Verify Shopify webhook HMAC signature
  function verifyWebhookHmac(req, res, next) {
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    if (!hmacHeader) {
      return res.status(401).json({ error: "Missing HMAC header" });
    }

    const secret = config.shopify.apiSecretKey;
    const body = req.body;
    const computedHmac = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("base64");

    if (
      !crypto.timingSafeEqual(
        Buffer.from(computedHmac),
        Buffer.from(hmacHeader)
      )
    ) {
      return res.status(401).json({ error: "HMAC validation failed" });
    }

    // Parse raw body to JSON for downstream handlers
    try {
      req.body = JSON.parse(body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    next();
  }

  router.use(verifyWebhookHmac);

  // ── customers/data_request ─────────────────────────────────────────────────
  // Shopify sends this when a customer requests their data.
  // Since this app does not store customer PII, we acknowledge and return 200.
  router.post("/customers/data_request", (req, res) => {
    const { shop_domain, customer } = req.body;
    console.log(
      `[GDPR] customers/data_request from ${shop_domain} for customer ${customer?.id}`
    );

    // This app does not store customer personal data.
    // If it did, you would compile and return the customer's data here.
    return res.status(200).json({ received: true });
  });

  // ── customers/redact ───────────────────────────────────────────────────────
  // Shopify sends this when a store owner requests deletion of customer data.
  router.post("/customers/redact", (req, res) => {
    const { shop_domain, customer } = req.body;
    console.log(
      `[GDPR] customers/redact from ${shop_domain} for customer ${customer?.id}`
    );

    // This app does not store customer personal data.
    // If it did, you would delete the customer's data here.
    return res.status(200).json({ received: true });
  });

  // ── shop/redact ────────────────────────────────────────────────────────────
  // Shopify sends this 48 hours after an app is uninstalled.
  // Delete all shop data.
  router.post("/shop/redact", (req, res) => {
    const { shop_domain } = req.body;
    console.log(`[GDPR] shop/redact for ${shop_domain}`);

    // TODO: Delete all data associated with this shop from the database.
    // For now, acknowledge receipt.
    return res.status(200).json({ received: true });
  });

  return router;
}

module.exports = { createWebhookRouter };
