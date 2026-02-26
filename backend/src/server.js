const express = require("express");
const dotenv = require("dotenv");

const { getConfig } = require("./config");
const { JsonStore } = require("./storage/jsonStore");
const { DesignRepository } = require("./repositories/designRepository");
const { AssetRepository } = require("./repositories/assetRepository");
const { ProductRepository } = require("./repositories/productRepository");
const { SettingsRepository } = require("./repositories/settingsRepository");
const { MemberRepository } = require("./repositories/memberRepository");
const { AuthService } = require("./services/authService");
const { MemberAuthService } = require("./services/memberAuthService");
const { AnalyticsService } = require("./services/analyticsService");
const { PodPipelineService } = require("./services/podPipelineService");
const { AssetStorageService } = require("./services/assetStorageService");
const { ShopifyPublishService } = require("./services/shopifyPublishService");
const { createPodRouter } = require("./routes/podRoutes");

dotenv.config();

function createServer() {
  const app = express();
  app.use(express.json({ limit: "20mb" }));

  const config = getConfig();
  const store = new JsonStore(config.storage.dataFilePath);

  const designRepository = new DesignRepository(store);
  const assetRepository = new AssetRepository(store);
  const productRepository = new ProductRepository(store);
  const settingsRepository = new SettingsRepository(store);
  const memberRepository = new MemberRepository(store);

  const authService = new AuthService(config);
  const memberAuthService = new MemberAuthService(memberRepository);
  const analyticsService = new AnalyticsService();
  const pipelineService = new PodPipelineService();
  const assetStorageService = new AssetStorageService(assetRepository);
  const publishService = new ShopifyPublishService(config);

  app.use("/api", (req, _res, next) => {
    analyticsService.track(req);
    next();
  });

  app.use(
    "/api",
    createPodRouter({
      authService,
      memberAuthService,
      memberRepository,
      analyticsService,
      designRepository,
      productRepository,
      settingsRepository,
      pipelineService,
      assetStorageService,
      publishService,
    })
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

module.exports = {
  createServer,
};
