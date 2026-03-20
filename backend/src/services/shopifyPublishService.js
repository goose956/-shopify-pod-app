const { retryWithBackoff } = require("../utils/retry");
const log = require("../utils/logger");

class ShopifyPublishService {
  constructor(config, settingsRepository) {
    this.config = config;
    this.settingsRepository = settingsRepository;
    // Base URL for converting relative /uploads/ paths to full public URLs
    this.appBaseUrl = (process.env.SHOPIFY_HOST_NAME || process.env.APP_URL || "").replace(/\/+$/, "");
    if (this.appBaseUrl && !this.appBaseUrl.startsWith("http")) {
      this.appBaseUrl = `https://${this.appBaseUrl}`;
    }
  }

  /**
   * Convert a potentially relative URL to a full public URL that Shopify can fetch.
   */
  _toPublicUrl(url) {
    if (!url) return null;
    // Already a full URL
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    // Relative path like /uploads/abc.png — prepend base URL
    if (this.appBaseUrl && url.startsWith("/")) {
      return `${this.appBaseUrl}${url}`;
    }
    log.warn({ url }, "Cannot resolve image URL to public URL (no APP_URL configured) — skipping");
    return null;
  }

  /**
   * Resolve the access token for a given shop.
   * Uses per-shop OAuth token from settingsRepository (stored during /auth/callback).
   * Falls back to SHOPIFY_ADMIN_ACCESS_TOKEN only in non-production (dev/test).
   */
  _getAccessToken(shopDomain) {
    // 1. Per-shop OAuth token (stored during /auth/callback)
    if (this.settingsRepository) {
      // Log all stored shops for diagnostics
      const allSettings = this.settingsRepository.store?.read?.()?.settings || [];
      const realShops = allSettings
        .filter(s => s.shopDomain && !s.shopDomain.startsWith("_nonce:") && s.shopDomain !== "_analytics")
        .map(s => ({ domain: s.shopDomain, hasToken: Boolean(s.shopifyAccessToken) }));
      log.info({ shopDomain, storedShops: realShops, storeType: this.settingsRepository.store?.constructor?.name || "unknown" }, "Token lookup — all stored shops");

      const shopSettings = this.settingsRepository.findByShop(shopDomain);
      if (shopSettings?.shopifyAccessToken) {
        log.info({ shopDomain }, "Token found for shop (exact match)");
        return shopSettings.shopifyAccessToken;
      }

      // Fuzzy match: try normalising the domain (strip trailing slashes, lowercase)
      const normalised = shopDomain.toLowerCase().replace(/\/+$/, "");
      for (const entry of allSettings) {
        if (!entry.shopDomain || !entry.shopifyAccessToken) continue;
        const entryNorm = entry.shopDomain.toLowerCase().replace(/\/+$/, "");
        if (entryNorm === normalised) {
          log.warn({ requested: shopDomain, stored: entry.shopDomain }, "Token found via fuzzy match — domain format mismatch!");
          return entry.shopifyAccessToken;
        }
      }
    }
    // 2. Dev/test fallback only — never use a global token in production
    //    (it belongs to a different store and will always 401)
    if (process.env.NODE_ENV !== "production") {
      const envToken = this.config.shopify.adminAccessToken || "";
      if (envToken) {
        log.debug({}, "No per-shop token — using env fallback (dev mode)");
        return envToken;
      }
    }
    log.warn({ shopDomain }, "No access token found — shop must complete OAuth install");
    return "";
  }

  /**
   * Helper: make a GraphQL call to Shopify.
   */
  async _graphql(shopDomain, accessToken, query, variables = {}) {
    const apiVersion = this.config.shopify.apiVersion;
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");

      // If 401, the token is stale/revoked — clear it
      if (response.status === 401 && this.settingsRepository) {
        log.warn({ shopDomain }, "Clearing stale token after GraphQL 401");
        this.settingsRepository.upsertByShop(shopDomain, { shopifyAccessToken: "", shopifyScopes: "" });
        this.settingsRepository.flush().catch(() => {});
      }

      const err = new Error(
        `Shopify API error (${response.status}): ${body.slice(0, 300)}`
      );
      err.status = response.status;
      throw err;
    }

    const payload = await response.json();

    // Check top-level GraphQL errors (schema / syntax errors)
    if (payload.errors && payload.errors.length > 0) {
      const msgs = payload.errors.map((e) => e.message).join("; ");
      log.error({ errors: payload.errors }, "ShopifyPublish GraphQL errors");
      throw new Error(`Shopify GraphQL error: ${msgs}`);
    }

    return payload;
  }

  /**
   * Create a product on Shopify as DRAFT (or ACTIVE) and optionally attach images.
   *
   * Strategy (all GraphQL — REST Admin API removed in 2025-04+):
   *  1. Create product via GraphQL productCreate (without images).
   *  2. Attach images via GraphQL productCreateMedia.
   *  3. Set variant pricing via GraphQL productVariantsBulkUpdate.
   */
  async publish({ shopDomain, title, descriptionHtml, tags, imageUrls, publishImmediately, price, compareAtPrice, productType }) {
    return retryWithBackoff(
      async () => {
        // Refresh cache from Postgres before token lookup to catch tokens
        // updated by OAuth callback (especially after reinstall)
        if (typeof this.settingsRepository?.store?.refreshCacheFromDb === "function") {
          try { await this.settingsRepository.store.refreshCacheFromDb(); } catch (_) { /* logged inside */ }
        }

        // Fetch token inside retry loop so a refreshed token is used after 401 clears the stale one
        const accessToken = this._getAccessToken(shopDomain);

        if (!accessToken) {
          const err = new Error(
            "No Shopify access token for this store. Please re-install the app: visit /auth/reinstall?shop=" + shopDomain
          );
          err.status = 401;
          throw err;
        }

        let productId = null;
        let numericId = null;

        // ── Create product via GraphQL productCreate ──
        const payload = await this._graphql(shopDomain, accessToken,
          `mutation productCreate($input: ProductInput!) {
            productCreate(input: $input) {
              product {
                id
                handle
                variants(first: 1) {
                  edges { node { id } }
                }
              }
              userErrors { field message }
            }
          }`,
          {
            input: {
              title,
              descriptionHtml,
              status: publishImmediately ? "ACTIVE" : "DRAFT",
              tags,
              ...(productType ? { productType } : {}),
            },
          }
        );

        const userErrors = payload?.data?.productCreate?.userErrors || [];
        if (userErrors.length > 0) {
          throw new Error(userErrors.map((e) => e.message).join("; ") || "productCreate failed");
        }

        const product = payload?.data?.productCreate?.product;
        if (!product?.id) {
          log.warn({ responsePreview: JSON.stringify(payload).slice(0, 500) }, "GraphQL returned no product");
          throw new Error("Shopify productCreate returned no product ID");
        }

        productId = product.id;
        numericId = product.id.split("/").pop();
        log.info({ productId }, "Product created via GraphQL");

        // ── Attach images via GraphQL productCreateMedia ──
        if (imageUrls && imageUrls.length > 0) {
          const publicUrls = imageUrls.map(u => this._toPublicUrl(u)).filter(Boolean);
          if (publicUrls.length > 0) {
            log.info({ imageCount: publicUrls.length, productId, urls: publicUrls }, "Attaching images to product");
            await this._attachImagesGraphQL(shopDomain, accessToken, productId, publicUrls);
          }
        }

        // ── Set variant pricing via GraphQL ──
        if (price) {
          const variantGid = product.variants?.edges?.[0]?.node?.id;
          if (variantGid) {
            try {
              await this._setVariantPricingGraphQL(shopDomain, accessToken, productId, variantGid, price, compareAtPrice);
            } catch (priceErr) {
              log.warn({ err: priceErr.message }, "Variant pricing failed (non-fatal)");
            }
          } else {
            log.warn({ productId }, "No variant GID returned — cannot set pricing");
          }
        }

        const shopSubdomain = shopDomain.split(".")[0];
        return {
          productId,
          adminUrl: `https://admin.shopify.com/store/${shopSubdomain}/products/${numericId}`,
        };
      },
      { maxRetries: 2, baseDelayMs: 1000, label: "ShopifyPublish" }
    );
  }

  /**
   * Set variant pricing via GraphQL productVariantsBulkUpdate.
   */
  async _setVariantPricingGraphQL(shopDomain, accessToken, productGid, variantGid, price, compareAtPrice) {
    const payload = await this._graphql(shopDomain, accessToken,
      `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price compareAtPrice }
          userErrors { field message }
        }
      }`,
      {
        productId: productGid,
        variants: [{
          id: variantGid,
          price,
          ...(compareAtPrice ? { compareAtPrice } : {}),
        }],
      }
    );

    const userErrors = payload?.data?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(userErrors.map((e) => e.message).join("; "));
    }

    log.info({ variantGid, price, compareAtPrice: compareAtPrice || "none" }, "Variant pricing set via GraphQL");
  }

  /**
   * Attach images to a product via GraphQL productCreateMedia.
   */
  async _attachImagesGraphQL(shopDomain, accessToken, productGid, imageUrls) {
    try {
      const media = imageUrls.map((url) => ({
        originalSource: url,
        mediaContentType: "IMAGE",
        alt: "Product image",
      }));

      const payload = await this._graphql(shopDomain, accessToken,
        `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { id status }
            mediaUserErrors { field message code }
          }
        }`,
        { productId: productGid, media }
      );

      const userErrors = payload?.data?.productCreateMedia?.mediaUserErrors || [];
      if (userErrors.length > 0) {
        log.warn({ userErrors }, "GraphQL productCreateMedia errors");
        return false;
      }

      const createdMedia = payload?.data?.productCreateMedia?.media || [];
      log.info({ mediaCount: createdMedia.length, productGid }, "GraphQL media attached to product");
      return createdMedia.length > 0;
    } catch (err) {
      log.warn({ err: err.message }, "GraphQL productCreateMedia failed");
      return false;
    }
  }
}

module.exports = {
  ShopifyPublishService,
};
