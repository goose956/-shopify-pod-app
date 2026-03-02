const express = require("express");
const crypto = require("crypto");
const log = require("../utils/logger");

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
    log.info({ shop_domain, customerId: customer?.id }, "GDPR customers/data_request");
    // This app does not store customer personal data.
    return res.status(200).json({ received: true });
  });

  // ── customers/redact ───────────────────────────────────────────────────────
  router.post("/customers/redact", (req, res) => {
    const { shop_domain, customer } = req.body;
    log.info({ shop_domain, customerId: customer?.id }, "GDPR customers/redact");
    // This app does not store customer personal data.
    return res.status(200).json({ received: true });
  });

  // ── shop/redact ────────────────────────────────────────────────────────────
  // Shopify sends this 48 hours after an app is uninstalled.
  // Delete ALL data associated with this shop from the database.
  router.post("/shop/redact", (req, res) => {
    const { shop_domain } = req.body;
    log.info({ shop_domain }, "GDPR shop/redact — purging all shop data");

    try {
      _purgeShopData(shop_domain);
      log.info({ shop_domain }, "GDPR shop/redact complete");
    } catch (err) {
      log.error({ shop_domain, err: err?.message }, "GDPR shop/redact error");
    }

    return res.status(200).json({ received: true });
  });

  // ── app/uninstalled ────────────────────────────────────────────────────────
  // Shopify sends this immediately when the merchant uninstalls the app.
  // Clean up access tokens and mark shop as uninstalled.
  router.post("/app/uninstalled", async (req, res) => {
    const shopDomain = req.headers["x-shopify-shop-domain"] || req.body?.myshopify_domain || "";
    log.info({ shopDomain }, "app/uninstalled webhook received");

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
          log.info({ shopDomain }, "Revoked access token");

          // Persist to Postgres so revocation survives restarts
          try {
            await settingsRepository.flush();
            log.info({ shopDomain }, "Token revocation flushed to Postgres");
          } catch (flushErr) {
            log.error({ shopDomain, err: flushErr?.message }, "Flush failed after token revocation");
          }
        }
      }
    } catch (err) {
      log.error({ err: err?.message }, "app/uninstalled error");
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
      log.info({ shopDomain, count: designs.length }, "Purged designs");
    }

    // Delete shop settings (API keys, access tokens)
    if (settingsRepository) {
      settingsRepository.deleteByShop(shopDomain);
      log.info({ shopDomain }, "Purged settings");
    }

    // Note: members are global (not shop-scoped), so they are not deleted here.
  }

  return router;
}

module.exports = { createWebhookRouter };
