class ShopifyPublishService {
  constructor(config) {
    this.config = config;
  }

  async publish({ shopDomain, title, descriptionHtml, tags, imageUrls, publishImmediately }) {
    const accessToken = this.config.shopify.adminAccessToken;
    const apiVersion = this.config.shopify.apiVersion;

    if (!accessToken) {
      const fallbackId = `gid://shopify/Product/mock-${Date.now()}`;
      const shopSubdomain = shopDomain.split(".")[0];
      return {
        productId: fallbackId,
        adminUrl: `https://admin.shopify.com/store/${shopSubdomain}/products`,
      };
    }

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
      throw new Error(`Shopify API error (${response.status})`);
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
  }
}

module.exports = {
  ShopifyPublishService,
};
