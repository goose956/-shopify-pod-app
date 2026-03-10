const express = require("express");
const crypto = require("crypto");
const log = require("../utils/logger");

/**
 * Shopify OAuth install + callback routes.
 * Stores offline access tokens per-shop in settingsRepository.
 */
function createAuthRouter({ config, authService, settingsRepository }) {
  const router = express.Router();
  const shopify = authService.shopify;

  // ── Nonce helpers (database-backed for multi-instance safety) ──────────
  function _saveNonce(nonce, shop) {
    settingsRepository.upsertByShop(`_nonce:${nonce}`, {
      shop,
      createdAt: Date.now(),
    });
    // Flush nonce to Postgres so it survives a restart between
    // redirect → callback (fire-and-forget is fine for nonces)
    settingsRepository.flush().catch((e) =>
      log.error({ err: e }, "OAuth nonce flush error")
    );
  }

  function _consumeNonce(nonce) {
    const entry = settingsRepository.findByShop(`_nonce:${nonce}`);
    if (!entry) return null;
    settingsRepository.deleteByShop(`_nonce:${nonce}`);
    // Reject nonces older than 10 minutes
    if (Date.now() - (entry.createdAt || 0) > 10 * 60 * 1000) return null;
    return entry;
  }

  // ── GET /auth/reinstall ──────────────────────────────────────────────────
  // Clears any stale token for the shop and forces a fresh OAuth flow.
  router.get("/auth/reinstall", (req, res) => {
    const shop = String(req.query.shop || "").trim();
    if (!shop || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
      return res.status(400).send("Missing or invalid shop parameter.");
    }

    // Clear old token so install detection and OAuth starts fresh
    const existing = settingsRepository.findByShop(shop);
    if (existing?.shopifyAccessToken) {
      log.info({ shop }, "Reinstall: clearing stale access token");
      settingsRepository.upsertByShop(shop, {
        shopifyAccessToken: "",
        shopifyScopes: "",
      });
      settingsRepository.flush().catch((e) =>
        log.error({ err: e }, "Reinstall flush error")
      );
    }

    return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  });

  // ── GET /auth ──────────────────────────────────────────────────────────────
  // Redirect merchant to Shopify consent screen
  router.get("/auth", (req, res) => {
    const shop = String(req.query.shop || "").trim();
    if (!shop || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
      return res.status(400).send("Missing or invalid shop parameter.");
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    _saveNonce(nonce, shop);

    const scopes = Array.isArray(config.shopify.scopes)
      ? config.shopify.scopes.join(",")
      : config.shopify.scopes;

    const host = config.shopify.hostName.replace(/^https?:\/\//, "");
    const redirectUri = `https://${host}/auth/callback`;

    const authUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${config.shopify.apiKey}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${nonce}`;

    return res.redirect(authUrl);
  });

  // ── GET /auth/callback ─────────────────────────────────────────────────────
  // Exchange authorization code for offline access token
  router.get("/auth/callback", async (req, res) => {
    const { shop, code, state, hmac, timestamp } = req.query;

    if (!shop || !code || !state || !hmac) {
      return res.status(400).send("Missing required query parameters.");
    }

    // Verify nonce (database-backed, consumed on use)
    const nonceEntry = _consumeNonce(state);
    if (!nonceEntry || nonceEntry.shop !== shop) {
      return res.status(403).send("Invalid state / nonce.");
    }

    // Verify HMAC
    const queryParams = { ...req.query };
    delete queryParams.hmac;
    const sortedParams = Object.keys(queryParams)
      .sort()
      .map((key) => `${key}=${queryParams[key]}`)
      .join("&");
    const computedHmac = crypto
      .createHmac("sha256", config.shopify.apiSecretKey)
      .update(sortedParams)
      .digest("hex");

    if (
      !crypto.timingSafeEqual(
        Buffer.from(computedHmac, "hex"),
        Buffer.from(hmac, "hex")
      )
    ) {
      return res.status(403).send("HMAC validation failed.");
    }

    // Exchange code for access token
    try {
      const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: config.shopify.apiKey,
          client_secret: config.shopify.apiSecretKey,
          code,
        }),
      });

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        log.error({ status: tokenResponse.status, body: errText }, "OAuth token exchange failed");
        return res.status(502).send("Token exchange failed.");
      }

      const tokenData = await tokenResponse.json();
      log.debug({ scope: tokenData.scope, hasToken: Boolean(tokenData.access_token) }, "OAuth token response received");
      const accessToken = tokenData.access_token;
      const grantedScopes = tokenData.scope || "";

      if (!accessToken) {
        log.error({ shop, scope: tokenData.scope }, "OAuth token exchange returned no access_token");
        return res.status(502).send("Token exchange returned no access token.");
      }

      // Validate the token immediately by calling Shopify
      try {
        const testResp = await fetch(
          `https://${shop}/admin/api/${config.shopify.apiVersion}/shop.json`,
          { headers: { "X-Shopify-Access-Token": accessToken } }
        );
        if (testResp.ok) {
          log.info({ shop }, "OAuth token validated successfully against Shopify API");
        } else {
          const testBody = await testResp.text().catch(() => "");
          log.error({ shop, status: testResp.status, body: testBody.slice(0, 200) }, "OAuth token FAILED validation — token may be invalid!");
        }
      } catch (valErr) {
        log.warn({ shop, err: valErr.message }, "OAuth token validation check failed (non-fatal)");
      }

      // Store the access token in settings for this shop
      settingsRepository.upsertByShop(shop, {
        shopifyAccessToken: accessToken,
        shopifyScopes: grantedScopes,
        installedAt: Date.now(),
      });

      // ── CRITICAL: flush to PostgreSQL BEFORE redirecting ──
      try {
        await settingsRepository.flush();
        log.info({ shop, storeType: settingsRepository.store?.constructor?.name || "unknown" }, "OAuth token flushed to persistent store");

        // Verify token was actually persisted
        const verifyAfterFlush = settingsRepository.findByShop(shop);
        log.info({ shop, tokenSaved: Boolean(verifyAfterFlush?.shopifyAccessToken), scopes: verifyAfterFlush?.shopifyScopes || "none" }, "OAuth post-flush verify (in-memory)");

        // Double-check: read directly from Postgres to confirm
        if (settingsRepository.store?.pool) {
          const pgResult = await settingsRepository.store.pool.query("SELECT data FROM app_data WHERE id = 1");
          if (pgResult.rows.length > 0) {
            const pgSettings = pgResult.rows[0].data?.settings || [];
            const match = pgSettings.find(s => s.shopDomain === shop);
            log.info({ shop, found: Boolean(match), hasToken: Boolean(match?.shopifyAccessToken), scopes: match?.shopifyScopes || "none" }, "OAuth Postgres direct verify");
          }
        } else {
          log.warn({ shop }, "No Postgres pool — token stored in ephemeral JSON (will be lost on redeploy!)");
        }
      } catch (flushErr) {
        log.error({ shop, err: flushErr }, "OAuth flush to PostgreSQL failed");
      }

      log.info({ shop, scopes: grantedScopes }, "OAuth app installed");

      // Verify it was saved
      const verify = settingsRepository.findByShop(shop);
      log.debug({ shop, tokenFound: Boolean(verify?.shopifyAccessToken) }, "OAuth verify save");

      // Redirect into embedded app
      const host = Buffer.from(`${shop}/admin`).toString("base64url");
      return res.redirect(
        `https://${shop}/admin/apps/${config.shopify.apiKey}`
      );
    } catch (err) {
      log.error({ err }, "OAuth callback error");
      return res.status(500).send("OAuth callback failed.");
    }
  });

  return router;
}

module.exports = { createAuthRouter };
