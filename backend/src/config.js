const path = require("path");

function getConfig() {
  return {
    shopify: {
      apiKey: process.env.SHOPIFY_API_KEY || "",
      apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
      scopes: (process.env.SHOPIFY_SCOPES || "write_products").split(","),
      hostName: (process.env.SHOPIFY_HOST_NAME || "").replace(/^https?:\/\//, ""),
      apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
      adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "",
    },
    dev: {
      allowBypass: process.env.ALLOW_DEV_BYPASS === "true",
      devShopDomain: process.env.DEV_SHOP_DOMAIN || "example.myshopify.com",
    },
    storage: {
      dataFilePath:
        process.env.APP_DATA_FILE || path.join(__dirname, "..", "data", "store.json"),
    },
  };
}

module.exports = {
  getConfig,
};
