const express = require("express");
const crypto = require("crypto");

/**
 * Shopify mandatory GDPR webhook handlers + APP_UNINSTALLED.
 * Required for App Store submission.
 * See: https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks
 */
function createWebhookRouter({ config, settingsRepository, designRepository, memberRepository }) {
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
  router.post("/customers/data_request", (req, res) => {
    const { shop_domain, customer } = req.body;
    console.log(
      `[GDPR] customers/data_request from ${shop_domain} for customer ${customer?.id}`
    );
    // This app does not store customer personal data.
    return res.status(200).json({ received: true });
  });

  // ── customers/redact ───────────────────────────────────────────────────────
  router.post("/customers/redact", (req, res) => {
    const { shop_domain, customer } = req.body;
    console.log(
      `[GDPR] customers/redact from ${shop_domain} for customer ${customer?.id}`
    );
    // This app does not store customer personal data.
    return res.status(200).json({ received: true });
  });

  // ── shop/redact ────────────────────────────────────────────────────────────
  // Shopify sends this 48 hours after an app is uninstalled.
  // Delete ALL data associated with this shop from the database.
  router.post("/shop/redact", (req, res) => {
    const { shop_domain } = req.body;
    console.log(`[GDPR] shop/redact for ${shop_domain} — purging all shop data`);

    try {
      _purgeShopData(shop_domain);
      console.log(`[GDPR] shop/redact complete for ${shop_domain}`);
    } catch (err) {
      console.error(`[GDPR] shop/redact error for ${shop_domain}:`, err?.message);
    }

    return res.status(200).json({ received: true });
  });

  // ── app/uninstalled ────────────────────────────────────────────────────────
  // Shopify sends this immediately when the merchant uninstalls the app.
  // Clean up access tokens and mark shop as uninstalled.
  router.post("/app/uninstalled", (req, res) => {
    const shopDomain = req.headers["x-shopify-shop-domain"] || req.body?.myshopify_domain || "";
    console.log(`[Webhook] app/uninstalled for ${shopDomain}`);

    try {
      // Revoke stored access token immediately
      if (settingsRepository) {
        const settings = settingsRepository.findByShop(shopDomain);
        if (settings) {
          settingsRepository.upsertByShop(shopDomain, {
            shopifyAccessToken: "",
            shopifyScopes: "",
            uninstalledAt: Date.now(),
          });
          console.log(`[Webhook] Revoked access token for ${shopDomain}`);
        }
      }
    } catch (err) {
      console.error(`[Webhook] app/uninstalled error:`, err?.message);
    }

    return res.status(200).json({ received: true });
  });

  /**
   * Purge all data for a given shop domain.
   * Called by shop/redact (48h after uninstall).
   */
  function _purgeShopData(shopDomain) {
    if (!shopDomain) return;

    // Delete all designs for this shop
    if (designRepository) {
      const designs = designRepository.listByShop(shopDomain);
      for (const design of designs) {
        designRepository.delete(design.id);
      }
      console.log(`[Purge] Deleted ${designs.length} designs for ${shopDomain}`);
    }

    // Delete shop settings (API keys, access tokens)
    if (settingsRepository) {
      settingsRepository.deleteByShop(shopDomain);
      console.log(`[Purge] Deleted settings for ${shopDomain}`);
    }

    // Note: members are global (not shop-scoped), so they are not deleted here.
  }

  return router;
}

module.exports = { createWebhookRouter };
