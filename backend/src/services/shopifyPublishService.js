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
    log.warn({ url }, "Cannot resolve image URL to public URL (no APP_URL configured)");
    return url;
  }

  /**
   * Resolve the access token for a given shop.
   * Priority: per-shop OAuth token (from settingsRepository) > global env token > null.
   */
  _getAccessToken(shopDomain) {
    // 1. Per-shop OAuth token (stored during /auth/callback)
    if (this.settingsRepository) {
      const shopSettings = this.settingsRepository.findByShop(shopDomain);
      log.debug({ shopDomain, hasToken: Boolean(shopSettings?.shopifyAccessToken) }, "Token lookup for shop");
      if (shopSettings?.shopifyAccessToken) {
        return shopSettings.shopifyAccessToken;
      }
    }
    // 2. Global fallback (single-tenant / dev mode)
    const envToken = this.config.shopify.adminAccessToken || "";
    log.debug({ hasEnvToken: envToken ? 'present' : 'empty' }, "No per-shop token, using env fallback");
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
      log.error({ errors: payload.errors }, "ShopifyPublish GraphQL errors");
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
  async publish({ shopDomain, title, descriptionHtml, tags, imageUrls, publishImmediately, price, compareAtPrice, productType }) {
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
            log.info({ productId }, "Product created via GraphQL");
          } else {
            log.warn({ responsePreview: JSON.stringify(payload).slice(0, 500) }, "GraphQL returned no product");
          }
        } catch (gqlErr) {
          log.warn({ err: gqlErr.message }, "GraphQL productCreate failed, falling back to REST");
        }

        // ── Attempt 2: REST fallback if GraphQL failed ──
        if (!productId) {
          const restData = {
            title,
            body_html: descriptionHtml,
            status: publishImmediately ? "active" : "draft",
            tags: Array.isArray(tags) ? tags.join(", ") : tags,
            images: (imageUrls || []).map((src) => ({ src: this._toPublicUrl(src) })).filter(i => i.src),
          };
          if (productType) restData.product_type = productType;
          // Include variant with pricing if price is provided
          if (price) {
            restData.variants = [{
              price,
              ...(compareAtPrice ? { compare_at_price: compareAtPrice } : {}),
              inventory_management: null,
            }];
          }
          const restProduct = await this._createProductREST(shopDomain, accessToken, restData);
          productId = `gid://shopify/Product/${restProduct.id}`;
          numericId = String(restProduct.id);
          log.info({ productId }, "Product created via REST");
        } else {
          // ── Attach images via GraphQL productCreateMedia (preferred) or REST fallback ──
          if (imageUrls && imageUrls.length > 0) {
            const publicUrls = imageUrls.map(u => this._toPublicUrl(u)).filter(Boolean);
            log.info({ imageCount: publicUrls.length, productId, urls: publicUrls }, "Attaching images to product");
            const attached = await this._attachImagesGraphQL(shopDomain, accessToken, productId, publicUrls);
            if (!attached) {
              log.info({}, "GraphQL media attach failed, trying REST fallback");
              await this._attachImagesREST(shopDomain, accessToken, numericId, publicUrls);
            }
          }
        }

        // ── Set variant pricing if product was created via GraphQL and price is provided ──
        if (productId && numericId && price) {
          try {
            await this._setVariantPricing(shopDomain, accessToken, numericId, price, compareAtPrice, productType);
          } catch (priceErr) {
            log.warn({ err: priceErr.message }, "Variant pricing failed (non-fatal)");
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
   * Set pricing on a product's default variant via REST.
   * Called after GraphQL product creation (which doesn't support variant pricing inline).
   */
  async _setVariantPricing(shopDomain, accessToken, numericProductId, price, compareAtPrice, productType) {
    const apiVersion = this.config.shopify.apiVersion;
    // First, get the product's variants
    const getUrl = `https://${shopDomain}/admin/api/${apiVersion}/products/${numericProductId}.json?fields=id,variants,product_type`;
    const getResp = await fetch(getUrl, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (!getResp.ok) {
      throw new Error(`Failed to fetch product variants (${getResp.status})`);
    }
    const productData = await getResp.json();
    const variants = productData?.product?.variants || [];

    // Update product_type if provided
    if (productType) {
      try {
        await fetch(`https://${shopDomain}/admin/api/${apiVersion}/products/${numericProductId}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
          body: JSON.stringify({ product: { id: numericProductId, product_type: productType } }),
        });
      } catch (_) { /* non-fatal */ }
    }

    if (variants.length === 0) {
      log.warn({}, "No variants found for pricing");
      return;
    }

    // Update the default (first) variant with pricing
    const variant = variants[0];
    const variantUrl = `https://${shopDomain}/admin/api/${apiVersion}/variants/${variant.id}.json`;
    const variantData = {
      variant: {
        id: variant.id,
        price,
        ...(compareAtPrice ? { compare_at_price: compareAtPrice } : {}),
      },
    };

    const putResp = await fetch(variantUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify(variantData),
    });

    if (!putResp.ok) {
      const body = await putResp.text().catch(() => "");
      throw new Error(`Variant pricing update failed (${putResp.status}): ${body.slice(0, 200)}`);
    }

    log.info({ variantId: variant.id, price, compareAtPrice: compareAtPrice || "none" }, "Variant pricing set");
  }

  /**
   * Create a product via the REST Admin API (works across all versions).
   */
  async _createProductREST(shopDomain, accessToken, productData) {
    const apiVersion = this.config.shopify.apiVersion;
    const url = `https://${shopDomain}/admin/api/${apiVersion}/products.json`;
    log.info({ url }, "REST POST to Shopify");

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
      log.error({ status: response.status, bodyPreview: body.slice(0, 500) }, "REST create failed");
      throw new Error(`Shopify REST product create failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    if (!data?.product?.id) {
      log.error({ responsePreview: JSON.stringify(data).slice(0, 500) }, "REST create returned no product");
      throw new Error("Shopify REST create returned no product");
    }

    log.info({ productId: data.product.id }, "REST product created");
    return data.product;
  }

  /**
   * Attach images to a product via GraphQL productCreateMedia (works in 2025-10+).
   * Returns true if successful, false if failed (so caller can try REST fallback).
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

  /**
   * Attach images to an existing product via the REST Admin API (fallback).
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
          log.warn({ status: response.status, bodyPreview: body.slice(0, 200) }, "Image attach failed");
        } else {
          log.info({ numericProductId }, "Image attached to product");
        }
      } catch (imgErr) {
        log.warn({ err: imgErr.message }, "Image attach error");
      }
    }
  }
}

module.exports = {
  ShopifyPublishService,
};
