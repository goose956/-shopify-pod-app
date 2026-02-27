const express = require("express");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const rateLimit = require("express-rate-limit");

const { getConfig } = require("./config");
const { JsonStore } = require("./storage/jsonStore");
const { PostgresStore } = require("./storage/pgStore");
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
const { PrintfulMockupService } = require("./services/printfulMockupService");
const { createPodRouter } = require("./routes/podRoutes");
const { createAuthRouter } = require("./routes/authRoutes");
const { createWebhookRouter } = require("./routes/webhookRoutes");

dotenv.config();

async function createServer() {
  const app = express();

  const config = getConfig();

  // ── Uploads directory ─────────────────────────────────────────────────────
  const uploadsDir = config.storage.uploadsDir;
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Trust proxy (Railway, Heroku, etc. terminate TLS)
  app.set("trust proxy", 1);

  // ── CSP / Frame-ancestors (required for Shopify embedded apps) ─────────
  app.use((req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors https://*.myshopify.com https://admin.shopify.com"
    );
    next();
  });

  // ── Data store (PostgreSQL in production, JSON file in dev) ───────────────
  // Created early so repositories are available for webhook handlers.
  let store;
  if (config.storage.databaseUrl) {
    console.log("[Storage] Using PostgreSQL");
    store = new PostgresStore(config.storage.databaseUrl);
    await store.waitForReady();
  } else {
    console.log("[Storage] Using JSON file:", config.storage.dataFilePath);
    store = new JsonStore(config.storage.dataFilePath);
  }

  const designRepository = new DesignRepository(store);
  const assetRepository = new AssetRepository(store);
  const productRepository = new ProductRepository(store);
  const settingsRepository = new SettingsRepository(store);
  const memberRepository = new MemberRepository(store);

  // ── GDPR + uninstall webhooks (mounted BEFORE express.json so raw body is available) ─
  app.use("/webhooks", createWebhookRouter({ config, settingsRepository, designRepository, memberRepository }));

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: "20mb" }));

  // Serve uploaded images as static files
  app.use("/uploads", express.static(uploadsDir, { maxAge: "7d" }));

  const authService = new AuthService(config);
  const memberAuthService = new MemberAuthService(memberRepository);
  const analyticsService = new AnalyticsService();
  const pipelineService = new PodPipelineService(uploadsDir);
  const assetStorageService = new AssetStorageService(assetRepository);
  const publishService = new ShopifyPublishService(config, settingsRepository);
  const printfulMockupService = new PrintfulMockupService(uploadsDir);

  // ── OAuth install/callback ────────────────────────────────────────────────
  app.use(createAuthRouter({ config, authService, settingsRepository }));

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });

  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many generation requests. Please wait a moment." },
  });

  app.use("/api", apiLimiter);
  app.use("/api/design-preview", aiLimiter);
  app.use("/api/generate-mockup", aiLimiter);
  app.use("/api/extract-artwork", aiLimiter);

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
      printfulMockupService,
    })
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // ── Serve built frontend in production ────────────────────────────────────
  const frontendDist = path.join(__dirname, "..", "..", "web", "frontend", "dist");
  app.use(express.static(frontendDist, { index: false }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/webhooks") || req.path.startsWith("/auth") || req.path.startsWith("/uploads") || req.path === "/health") {
      return next();
    }
    res.sendFile(path.join(frontendDist, "index.html"), (err) => {
      if (err) next();
    });
  });

  // ── Global error handler ──────────────────────────────────────────────────
  app.use((err, _req, res, _next) => {
    console.error("[Unhandled Error]", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

module.exports = {
  createServer,
};
