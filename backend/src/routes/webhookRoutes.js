const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const log = require("../utils/logger");

/**
 * Shopify mandatory GDPR webhook handlers + APP_UNINSTALLED.
 * Required for App Store submission.
 * See: https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks
 */
function createWebhookRouter(deps) {
  const router = express.Router();
  const config = deps.config;

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
      _purgeShopData(shop_domain, deps);
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
      const settingsRepository = deps.settingsRepository;
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
  function _purgeShopData(shopDomain, deps) {
    if (!shopDomain) return;
    const { designRepository, assetRepository, productRepository, settingsRepository } = deps;
    const uploadsDir = deps.uploadsDir;

    // Delete all designs + their assets + products + uploaded files
    if (designRepository) {
      const designs = designRepository.listByShop(shopDomain);
      for (const design of designs) {
        // Delete associated assets
        try {
          const assets = assetRepository ? assetRepository.listByDesign(design.id) : [];
          // Delete uploaded files referenced by assets
          for (const asset of assets) {
            if (asset.url && asset.url.startsWith("/uploads/")) {
              const filePath = path.join(uploadsDir, path.basename(asset.url));
              try { fs.unlinkSync(filePath); } catch (_) { /* already deleted */ }
            }
          }
          if (assetRepository) assetRepository.deleteByDesign(design.id);
        } catch (err) {
          log.warn({ err: err?.message, designId: design.id }, "Error purging assets");
        }

        // Delete associated products
        try {
          if (productRepository) productRepository.deleteByDesign(design.id);
        } catch (err) {
          log.warn({ err: err?.message, designId: design.id }, "Error purging products");
        }

        // Delete uploaded files referenced by the design itself
        for (const urlField of ["previewImageUrl", "rawArtworkUrl", "mockupImageUrl"]) {
          const url = design[urlField];
          if (url && url.startsWith("/uploads/")) {
            try { fs.unlinkSync(path.join(uploadsDir, path.basename(url))); } catch (_) { /* ok */ }
          }
        }

        designRepository.delete(design.id);
      }
      log.info({ shopDomain, count: designs.length }, "Purged designs, assets, products, and files");
    }

    // Delete shop settings (API keys, access tokens)
    if (settingsRepository) {
      settingsRepository.deleteByShop(shopDomain);
      log.info({ shopDomain }, "Purged settings");
    }
  }

  return router;
}

module.exports = { createWebhookRouter };
