const { retryWithBackoff } = require("../utils/retry");

class ShopifyPublishService {
  constructor(config, settingsRepository) {
    this.config = config;
    this.settingsRepository = settingsRepository;
  }

  /**
   * Resolve the access token for a given shop.
   * Priority: per-shop OAuth token (from settingsRepository) > global env token > null.
   */
  _getAccessToken(shopDomain) {
    // 1. Per-shop OAuth token (stored during /auth/callback)
    if (this.settingsRepository) {
      const shopSettings = this.settingsRepository.findByShop(shopDomain);
      console.log(`[ShopifyPublish] Token lookup for "${shopDomain}": found=${Boolean(shopSettings?.shopifyAccessToken)}, tokenPrefix=${shopSettings?.shopifyAccessToken ? shopSettings.shopifyAccessToken.slice(0, 8) + '...' : 'none'}`);
      if (shopSettings?.shopifyAccessToken) {
        return shopSettings.shopifyAccessToken;
      }
    }
    // 2. Global fallback (single-tenant / dev mode)
    const envToken = this.config.shopify.adminAccessToken || "";
    console.log(`[ShopifyPublish] No per-shop token, env fallback: ${envToken ? 'present' : 'empty'}`);
    return envToken;
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
      console.error("[ShopifyPublish] GraphQL errors:", JSON.stringify(payload.errors));
      throw new Error(`Shopify GraphQL error: ${msgs}`);
    }

    return payload;
  }

  /**
   * Create a product on Shopify as DRAFT (or ACTIVE) and optionally attach images.
   *
   * Strategy:
   *  1. Try modern productCreate WITHOUT images (images field removed in 2024-04+).
   *  2. Attach images via REST Admin Products API (stable across versions).
   *  3. If modern mutation fails, fall back to REST product creation entirely.
   */
  async publish({ shopDomain, title, descriptionHtml, tags, imageUrls, publishImmediately }) {
    const accessToken = this._getAccessToken(shopDomain);

    if (!accessToken) {
      const fallbackId = `gid://shopify/Product/mock-${Date.now()}`;
      const shopSubdomain = shopDomain.split(".")[0];
      return {
        productId: fallbackId,
        adminUrl: `https://admin.shopify.com/store/${shopSubdomain}/products`,
      };
    }

    return retryWithBackoff(
      async () => {
        let productId = null;
        let numericId = null;

        // ── Attempt 1: GraphQL productCreate (without images) ──
        try {
          const payload = await this._graphql(shopDomain, accessToken,
            `mutation productCreate($input: ProductInput!) {
              productCreate(input: $input) {
                product { id handle }
                userErrors { field message }
              }
            }`,
            {
              input: {
                title,
                descriptionHtml,
                status: publishImmediately ? "ACTIVE" : "DRAFT",
                tags,
              },
            }
          );

          const userErrors = payload?.data?.productCreate?.userErrors || [];
          if (userErrors.length > 0) {
            throw new Error(userErrors.map((e) => e.message).join("; ") || "productCreate failed");
          }

          const product = payload?.data?.productCreate?.product;
          if (product?.id) {
            productId = product.id;
            numericId = product.id.split("/").pop();
            console.log(`[ShopifyPublish] Product created via GraphQL: ${productId}`);
          } else {
            console.warn("[ShopifyPublish] GraphQL returned no product, full response:", JSON.stringify(payload).slice(0, 500));
          }
        } catch (gqlErr) {
          console.warn("[ShopifyPublish] GraphQL productCreate failed, falling back to REST:", gqlErr.message);
        }

        // ── Attempt 2: REST fallback if GraphQL failed ──
        if (!productId) {
          const restProduct = await this._createProductREST(shopDomain, accessToken, {
            title,
            body_html: descriptionHtml,
            status: publishImmediately ? "active" : "draft",
            tags: Array.isArray(tags) ? tags.join(", ") : tags,
            images: (imageUrls || []).map((src) => ({ src })),
          });
          productId = `gid://shopify/Product/${restProduct.id}`;
          numericId = String(restProduct.id);
          console.log(`[ShopifyPublish] Product created via REST: ${productId}`);
        } else {
          // ── Attach images via REST (GraphQL path — images not included) ──
          if (imageUrls && imageUrls.length > 0) {
            await this._attachImagesREST(shopDomain, accessToken, numericId, imageUrls);
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
   * Create a product via the REST Admin API (works across all versions).
   */
  async _createProductREST(shopDomain, accessToken, productData) {
    const apiVersion = this.config.shopify.apiVersion;
    const url = `https://${shopDomain}/admin/api/${apiVersion}/products.json`;
    console.log(`[ShopifyPublish] REST POST ${url}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ product: productData }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("[ShopifyPublish] REST create failed:", response.status, body.slice(0, 500));
      throw new Error(`Shopify REST product create failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    if (!data?.product?.id) {
      console.error("[ShopifyPublish] REST create returned no product:", JSON.stringify(data).slice(0, 500));
      throw new Error("Shopify REST create returned no product");
    }

    console.log(`[ShopifyPublish] REST product created: ${data.product.id}`);
    return data.product;
  }

  /**
   * Attach images to an existing product via the REST Admin API.
   */
  async _attachImagesREST(shopDomain, accessToken, numericProductId, imageUrls) {
    const apiVersion = this.config.shopify.apiVersion;
    for (const src of imageUrls) {
      try {
        const url = `https://${shopDomain}/admin/api/${apiVersion}/products/${numericProductId}/images.json`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ image: { src } }),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.warn(`[ShopifyPublish] Image attach failed (${response.status}): ${body.slice(0, 200)}`);
        } else {
          console.log(`[ShopifyPublish] Image attached to product ${numericProductId}`);
        }
      } catch (imgErr) {
        console.warn(`[ShopifyPublish] Image attach error: ${imgErr.message}`);
      }
    }
  }
}

module.exports = {
  ShopifyPublishService,
};
