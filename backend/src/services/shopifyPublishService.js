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
      if (shopSettings?.shopifyAccessToken) {
        return shopSettings.shopifyAccessToken;
      }
    }
    // 2. Global fallback (single-tenant / dev mode)
    return this.config.shopify.adminAccessToken || "";
  }

  async publish({ shopDomain, title, descriptionHtml, tags, imageUrls, publishImmediately }) {
    const accessToken = this._getAccessToken(shopDomain);
    const apiVersion = this.config.shopify.apiVersion;

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
        const response = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: `mutation productCreate($input: ProductInput!) {
              productCreate(input: $input) {
                product { id handle }
                userErrors { field message }
              }
            }`,
            variables: {
              input: {
                title,
                descriptionHtml,
                status: publishImmediately ? "ACTIVE" : "DRAFT",
                tags,
                images: imageUrls.map((src) => ({ src })),
              },
            },
          }),
        });

        if (!response.ok) {
          const err = new Error(`Shopify API error (${response.status})`);
          err.status = response.status;
          throw err;
        }

        const payload = await response.json();
        const userErrors = payload?.data?.productCreate?.userErrors || [];
        if (userErrors.length > 0) {
          throw new Error(userErrors[0].message || "productCreate failed");
        }

        const product = payload?.data?.productCreate?.product;
        if (!product?.id) {
          throw new Error("Invalid Shopify productCreate response");
        }

        const shopSubdomain = shopDomain.split(".")[0];
        return {
          productId: product.id,
          adminUrl: `https://admin.shopify.com/store/${shopSubdomain}/products/${product.id.split("/").pop()}`,
        };
      },
      { maxRetries: 2, baseDelayMs: 1000, label: "ShopifyPublish" }
    );
  }
}

module.exports = {
  ShopifyPublishService,
};
