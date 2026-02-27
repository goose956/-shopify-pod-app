const express = require("express");
const crypto = require("crypto");

/**
 * Shopify OAuth install + callback routes.
 * Stores offline access tokens per-shop in settingsRepository.
 */
function createAuthRouter({ config, authService, settingsRepository }) {
  const router = express.Router();
  const shopify = authService.shopify;
  const nonces = new Map();

  // ── GET /auth ──────────────────────────────────────────────────────────────
  // Redirect merchant to Shopify consent screen
  router.get("/auth", (req, res) => {
    const shop = String(req.query.shop || "").trim();
    if (!shop || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
      return res.status(400).send("Missing or invalid shop parameter.");
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    nonces.set(nonce, { shop, createdAt: Date.now() });

    // Clean stale nonces (>10 minutes)
    for (const [k, v] of nonces) {
      if (Date.now() - v.createdAt > 10 * 60 * 1000) nonces.delete(k);
    }

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

    // Verify nonce
    const nonceEntry = nonces.get(state);
    if (!nonceEntry || nonceEntry.shop !== shop) {
      return res.status(403).send("Invalid state / nonce.");
    }
    nonces.delete(state);

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
        console.error("[OAuth] Token exchange failed:", errText);
        return res.status(502).send("Token exchange failed.");
      }

      const tokenData = await tokenResponse.json();
      const accessToken = tokenData.access_token;
      const grantedScopes = tokenData.scope;

      // Store the access token in settings for this shop
      settingsRepository.upsertByShop(shop, {
        shopifyAccessToken: accessToken,
        shopifyScopes: grantedScopes,
        installedAt: Date.now(),
      });

      console.log(`[OAuth] App installed for shop: ${shop}`);

      // Redirect into embedded app
      const host = Buffer.from(`${shop}/admin`).toString("base64url");
      return res.redirect(
        `https://${shop}/admin/apps/${config.shopify.apiKey}`
      );
    } catch (err) {
      console.error("[OAuth] Callback error:", err);
      return res.status(500).send("OAuth callback failed.");
    }
  });

  return router;
}

module.exports = { createAuthRouter };
