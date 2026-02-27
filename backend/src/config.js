const path = require("path");

function getConfig() {
  return {
    shopify: {
      apiKey: process.env.SHOPIFY_API_KEY || "",
      apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
      scopes: (process.env.SHOPIFY_SCOPES || "read_products,write_products,read_orders,write_orders").split(","),
      hostName: (process.env.SHOPIFY_HOST_NAME || "").replace(/^https?:\/\//, ""),
      apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
      adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "",
    },
    dev: {
      allowBypass: process.env.ALLOW_DEV_BYPASS === "true",
      devShopDomain: process.env.DEV_SHOP_DOMAIN || "example.myshopify.com",
      setupSecret: process.env.SETUP_SECRET || "",
    },
    defaults: {
      openAiApiKey: process.env.OPENAI_API_KEY || "",
      printfulApiKey: process.env.PRINTFUL_API_KEY || "",
      kieApiKey: process.env.KIE_API_KEY || "",
    },
    storage: {
      databaseUrl: process.env.DATABASE_URL || "",
      dataFilePath:
        process.env.APP_DATA_FILE || path.join(__dirname, "..", "data", "store.json"),
      uploadsDir:
        process.env.UPLOADS_DIR || path.join(__dirname, "..", "data", "uploads"),
    },
  };
}

module.exports = {
  getConfig,
};
