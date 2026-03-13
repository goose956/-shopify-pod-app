require("@shopify/shopify-api/adapters/node");
const { shopifyApi } = require("@shopify/shopify-api");
const log = require("../utils/logger");

function getSessionToken(req) {
  const bearer = String(req.headers.authorization || "");
  if (bearer.startsWith("Bearer ")) {
    return bearer.slice(7).trim();
  }

  return String(req.headers["x-shopify-session-token"] || "").trim();
}

class AuthService {
  constructor(config) {
    this.config = config;
    this._startedAt = Date.now();
    // Setup secret expires after this many hours (default 72h)
    this._setupTtlMs = (Number(process.env.SETUP_SECRET_TTL_HOURS) || 72) * 60 * 60 * 1000;
    this.shopify = shopifyApi({
      apiKey: config.shopify.apiKey,
      apiSecretKey: config.shopify.apiSecretKey,
      scopes: config.shopify.scopes,
      hostName: config.shopify.hostName,
      apiVersion: config.shopify.apiVersion,
      isEmbeddedApp: true,
    });
  }

  async validateRequest(req) {
    const token = getSessionToken(req);
    if (!token) {
      return null;
    }

    // Setup secret — allows admin access before Shopify OAuth is complete.
    // Auto-expires after SETUP_SECRET_TTL_HOURS (default 72h) from server start.
    if (this.config.dev.setupSecret && token === this.config.dev.setupSecret) {
      const elapsed = Date.now() - this._startedAt;
      if (elapsed > this._setupTtlMs) {
        log.warn("SETUP_SECRET expired — server running longer than TTL. Redeploy to reset.");
        return null;
      }
      return {
        shopDomain: this.config.dev.devShopDomain,
        subject: "setup-admin",
      };
    }

    // Dev bypass — blocked in production (NODE_ENV=production)
    if (this.config.dev.allowBypass && token === "dev-session-token") {
      if (process.env.NODE_ENV === "production") {
        log.warn("ALLOW_DEV_BYPASS is true in production — ignoring dev token for safety");
        return null;
      }
      return {
        shopDomain: this.config.dev.devShopDomain,
        subject: "dev-bypass",
      };
    }

    if (!this.shopify?.session?.decodeSessionToken) {
      return null;
    }

    try {
      const payload = await this.shopify.session.decodeSessionToken(token);
      const shopDomain = payload?.dest ? String(payload.dest).replace(/^https?:\/\//, "") : "";
      log.info({ shopDomain, dest: payload?.dest, iss: payload?.iss }, "JWT session decoded");
      if (!shopDomain) {
        return null;
      }

      return {
        shopDomain,
        subject: payload.sub || "",
      };
    } catch (err) {
      log.debug({ err: err.message }, "Session token decode failed");
      return null;
    }
  }
}

module.exports = {
  AuthService,
};
