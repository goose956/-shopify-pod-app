require("@shopify/shopify-api/adapters/node");
const { shopifyApi } = require("@shopify/shopify-api");

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

    // Dev bypass — blocked in production (NODE_ENV=production)
    if (this.config.dev.allowBypass && token === "dev-session-token") {
      if (process.env.NODE_ENV === "production") {
        console.warn("[Auth] ALLOW_DEV_BYPASS is true in production — ignoring dev token for safety");
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
      if (!shopDomain) {
        return null;
      }

      return {
        shopDomain,
        subject: payload.sub || "",
      };
    } catch {
      return null;
    }
  }
}

module.exports = {
  AuthService,
};
