const express = require("express");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const rateLimit = require("express-rate-limit");
const cors = require("cors");

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
const { createBillingRouter } = require("./routes/billingRoutes");
const { BillingService } = require("./services/billingService");
const { startUploadsCleaner } = require("./utils/uploadsCleaner");
const log = require("./utils/logger");

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

  // ── CORS ──────────────────────────────────────────────────────────────────
  const allowedOrigins = [
    /\.myshopify\.com$/,
    /admin\.shopify\.com$/,
  ];
  if (config.shopify.hostName) {
    allowedOrigins.push(new RegExp(config.shopify.hostName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
  }
  if (process.env.NODE_ENV !== "production") {
    allowedOrigins.push(/^http:\/\/localhost(:\d+)?$/);
  }
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.some((o) => o.test(origin))) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  }));

  // ── Health check (responds even while DB is still initialising) ────────
  let dbReady = false;
  let storeType = "unknown";
  app.get("/health", (_req, res) => {
    res.json({ ok: true, dbReady, storeType });
  });

  // ── Admin: reset billing credits (no Shopify session needed) ────────────
  // Usage: POST /admin/reset-credits?secret=YOUR_SETUP_SECRET
  // Or:    GET  /admin/reset-credits?secret=YOUR_SETUP_SECRET  (for quick browser use)
  const handleResetCredits = async (req, res) => {
    const secret = String(req.query.secret || req.headers["x-admin-secret"] || "").trim();
    if (!config.dev.setupSecret || secret !== config.dev.setupSecret) {
      return res.status(401).json({ error: "Invalid or missing secret" });
    }
    try {
      // Wait for store to be ready
      if (!dbReady) return res.status(503).json({ error: "Database not ready yet" });
      // We need settingsRepository — it may not be wired yet at boot
      if (!_settingsRepository) return res.status(503).json({ error: "App still initialising" });

      const db = _settingsRepository.store.read();
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      let resetCount = 0;
      for (const s of db.settings) {
        if (s.billingUsage) {
          s.billingUsage = { credits: 0, periodStart };
          resetCount++;
        }
      }
      _settingsRepository.store.write(db);
      log.info({ resetCount }, "Admin: billing credits reset for all shops");
      return res.json({ ok: true, resetCount, message: `Reset credits to 0 for ${resetCount} shop(s)` });
    } catch (err) {
      log.error({ err: err.message }, "Admin reset-credits error");
      return res.status(500).json({ error: err.message });
    }
  };
  app.get("/admin/reset-credits", handleResetCredits);
  app.post("/admin/reset-credits", handleResetCredits);

  // ── Admin: secret auth middleware ─────────────────────────────────────────
  function adminAuth(req, res, next) {
    const secret = String(req.query.secret || req.headers["x-admin-secret"] || "").trim();
    if (!config.dev.setupSecret || secret !== config.dev.setupSecret) {
      return res.status(401).json({ error: "Invalid or missing secret" });
    }
    next();
  }

  // ── Admin Dashboard (self-contained HTML page) ────────────────────────────
  app.get("/admin", adminAuth, (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "pages", "admin.html"));
  });

  // ── Admin API: list shops ─────────────────────────────────────────────────
  app.get("/admin/api/shops", adminAuth, async (req, res) => {
    if (!_settingsRepository) return res.status(503).json({ error: "App still initialising" });
    try {
      const db = _settingsRepository.store.read();
      const shops = (db.settings || [])
        .filter(s => s.shopDomain && !s.shopDomain.startsWith("_nonce:") && s.shopDomain !== "_analytics")
        .map(s => ({
          domain: s.shopDomain,
          hasToken: Boolean(s.shopifyAccessToken),
          billingPlan: s.billingPlan || "free",
          billingUsage: s.billingUsage || { credits: 0, periodStart: null },
          installedAt: s.installedAt || null,
        }));

      // Count designs per shop
      const designs = db.designs || [];
      for (const shop of shops) {
        shop.designCount = designs.filter(d => d.shopDomain === shop.domain).length;
      }

      return res.json({ shops });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Admin API: image storage stats ────────────────────────────────────────
  app.get("/admin/api/image-stats", adminAuth, async (req, res) => {
    try {
      if (store?.getImageStats) {
        const stats = await store.getImageStats();
        return res.json({ stats });
      }
      return res.json({ stats: [], message: "No database storage available" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Admin API: diagnose connectivity ──────────────────────────────────────
  app.get("/admin/api/diagnose", adminAuth, async (req, res) => {
    const results = { timestamp: new Date().toISOString(), checks: {} };

    results.checks.envVars = {
      OPENAI_API_KEY: config.defaults.openAiApiKey ? "set" : "NOT SET",
      DATABASE_URL: config.storage.databaseUrl ? "set" : "NOT SET",
    };

    // Test Shopify tokens
    if (_settingsRepository) {
      const db = _settingsRepository.store.read();
      const shops = (db.settings || []).filter(s => s.shopDomain && !s.shopDomain.startsWith("_nonce:") && s.shopDomain !== "_analytics" && s.shopifyAccessToken);
      results.checks.shopifyTokens = [];
      for (const s of shops) {
        try {
          const testResp = await fetch(
            `https://${s.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": s.shopifyAccessToken },
              body: JSON.stringify({ query: "{ shop { name } }" }),
            }
          );
          if (testResp.ok) {
            const data = await testResp.json();
            results.checks.shopifyTokens.push({ domain: s.shopDomain, status: "VALID", shopName: data?.data?.shop?.name });
          } else {
            results.checks.shopifyTokens.push({ domain: s.shopDomain, status: "INVALID", httpStatus: testResp.status });
          }
        } catch (err) {
          results.checks.shopifyTokens.push({ domain: s.shopDomain, status: "ERROR", error: err.message });
        }
      }
    }

    // Test OpenAI
    if (config.defaults.openAiApiKey) {
      try {
        const testResp = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${config.defaults.openAiApiKey}` },
        });
        results.checks.openAi = { status: testResp.ok ? "CONNECTED" : "FAILED", httpStatus: testResp.status };
      } catch (err) {
        results.checks.openAi = { status: "ERROR", error: err.message };
      }
    } else {
      results.checks.openAi = { status: "NOT SET" };
    }

    return res.json(results);
  });

  // ── Admin API: reset credits for a specific shop ──────────────────────────
  app.post("/admin/api/reset-credits", adminAuth, async (req, res) => {
    if (!_settingsRepository) return res.status(503).json({ error: "App still initialising" });
    try {
      const shopDomain = String(req.body?.shopDomain || "").trim();
      const db = _settingsRepository.store.read();
      const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      let resetCount = 0;
      for (const s of db.settings) {
        if (shopDomain && s.shopDomain !== shopDomain) continue;
        if (s.billingUsage) {
          s.billingUsage = { credits: 0, periodStart };
          resetCount++;
        }
      }
      _settingsRepository.store.write(db);
      return res.json({ ok: true, resetCount });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Admin API: delete images for a specific shop ──────────────────────────
  app.post("/admin/api/delete-images", adminAuth, async (req, res) => {
    try {
      const shopDomain = String(req.body?.shopDomain || "").trim();
      if (!shopDomain) return res.status(400).json({ error: "shopDomain is required" });
      if (!store?.deleteShopImages) return res.status(400).json({ error: "No database storage" });
      const deleted = await store.deleteShopImages(shopDomain);
      return res.json({ ok: true, deleted });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Legacy admin/diagnose redirect ────────────────────────────────────────
  app.get("/admin/diagnose", adminAuth, (req, res) => {
    res.redirect(`/admin/api/diagnose?secret=${encodeURIComponent(req.query.secret)}`);
  });

  // ── Body parsing (skip /webhooks — they need raw body for HMAC) ────────────
  app.use((req, res, next) => {
    if (req.path.startsWith("/webhooks")) return next();
    express.json({ limit: "20mb" })(req, res, next);
  });

  // ── Serve uploaded images as static files ─────────────────────────────────
  app.use("/uploads", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  }, express.static(uploadsDir, { maxAge: "7d" }));

  // ── Serve DB-backed images ────────────────────────────────────────────────
  app.get("/images/:id", async (req, res) => {
    try {
      if (!store?.getImage) return res.status(404).send("Not found");
      const id = req.params.id;
      // Validate UUID format to prevent injection
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).send("Invalid image ID");
      }
      const image = await store.getImage(id);
      if (!image) return res.status(404).send("Not found");
      res.setHeader("Content-Type", image.mimeType || "image/png");
      res.setHeader("Cache-Control", "public, max-age=604800");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(image.data);
    } catch (err) {
      log.error({ err: err?.message }, "Error serving image from DB");
      res.status(500).send("Internal error");
    }
  });

  // ── Serve built frontend (no DB needed – register before listen) ──────────
  const frontendDist = path.join(__dirname, "..", "..", "web", "frontend", "dist");
  app.use(express.static(frontendDist, {
    // Don't serve index.html from static — we handle it below with API key injection
    index: false,
  }));

  // ── Public legal pages (required for Shopify App Store) ───────────────────
  app.get("/privacy", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "pages", "privacy.html"));
  });
  app.get("/terms", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "pages", "terms.html"));
  });

  // SPA catch-all: serve index.html for any non-API GET request, injecting the API key.
  // If a ?shop= param is present AND we have a DB with no valid token for that shop,
  // redirect to the OAuth install flow so the token is obtained before the app loads.
  let _settingsRepository = null; // populated after DB init
  app.get("*", async (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/webhooks") || req.path.startsWith("/auth") || req.path.startsWith("/uploads") || req.path.startsWith("/images/") || req.path.startsWith("/admin") || req.path === "/health" || req.path === "/privacy" || req.path === "/terms") {
      return next();
    }

    // ── Install detection: redirect to OAuth if shop has no token ──────────
    const shopParam = String(req.query.shop || "").trim();
    if (shopParam && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopParam) && _settingsRepository) {
      // If coming from Shopify admin (hmac present), refresh cache from DB
      // and validate the stored token — it may have been revoked by an uninstall.
      if (req.query.hmac && typeof store?.refreshCacheFromDb === "function") {
        try {
          await store.refreshCacheFromDb();
        } catch (_) { /* logged inside */ }
      }

      const existing = _settingsRepository.findByShop(shopParam);
      if (!existing?.shopifyAccessToken) {
        log.info({ shop: shopParam }, "Install detection: no token for shop — redirecting to OAuth");
        return res.redirect(`/auth?shop=${encodeURIComponent(shopParam)}`);
      }
    }

    const indexPath = path.join(frontendDist, "index.html");
    fs.readFile(indexPath, "utf8", (err, html) => {
      if (err) return next();
      const injected = html.replace(/%SHOPIFY_API_KEY%/g, config.shopify.apiKey || "");
      res.type("html").send(injected);
    });
  });

  // ── GDPR + uninstall webhooks (register early so compliance checks never 404) ──
  const webhookDeps = { config, settingsRepository: null, designRepository: null, memberRepository: null, assetRepository: null, productRepository: null, uploadsDir };
  app.use("/webhooks", createWebhookRouter(webhookDeps));

  // ── Start listening IMMEDIATELY so Railway health-checks pass ─────────
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => {
    log.info({ port }, "Backend listening (initialising…)");
  });

  // ── Data store (PostgreSQL in production, JSON file in dev) ───────────────
  let store;
  try {
    if (config.storage.databaseUrl) {
      log.info({ urlPrefix: config.storage.databaseUrl.slice(0, 25) + "..." }, "Using PostgreSQL");
      store = new PostgresStore(config.storage.databaseUrl);
      await store.waitForReady();
      storeType = "PostgresStore";
    } else if (process.env.NODE_ENV === "production") {
      log.fatal("DATABASE_URL is required in production — refusing to start with ephemeral storage");
      process.exit(1);
    } else {
      log.warn({ path: config.storage.dataFilePath }, "DATABASE_URL not set — using ephemeral JSON file (dev only)");
      store = new JsonStore(config.storage.dataFilePath);
      storeType = "JsonStore";
    }
  } catch (err) {
    log.fatal({ err }, "Database initialisation failed");
    process.exit(1);
  }
  dbReady = true;
  log.info("DB ready, finishing route setup…");

  const designRepository = new DesignRepository(store);
  const assetRepository = new AssetRepository(store);
  const productRepository = new ProductRepository(store);
  const settingsRepository = new SettingsRepository(store);
  const memberRepository = new MemberRepository(store);

  // Enable install detection in the SPA catch-all now that DB is ready
  _settingsRepository = settingsRepository;

  // Populate webhook deps now that DB is ready
  webhookDeps.settingsRepository = settingsRepository;
  webhookDeps.designRepository = designRepository;
  webhookDeps.memberRepository = memberRepository;
  webhookDeps.assetRepository = assetRepository;
  webhookDeps.productRepository = productRepository;
  webhookDeps.store = store;

  const authService = new AuthService(config);
  const memberAuthService = new MemberAuthService(memberRepository);
  const analyticsService = new AnalyticsService(settingsRepository);
  const pipelineService = new PodPipelineService(uploadsDir, store);
  const assetStorageService = new AssetStorageService(assetRepository);
  const publishService = new ShopifyPublishService(config, settingsRepository);
  const printfulMockupService = new PrintfulMockupService(uploadsDir);
  const billingService = new BillingService(settingsRepository, config);

  // ── OAuth install/callback ────────────────────────────────────────────────
  app.use(createAuthRouter({ config, authService, settingsRepository }));

  // ── Billing routes ────────────────────────────────────────────────────────
  app.use("/api/billing", createBillingRouter({
    authService,
    billingService,
    settingsRepository,
    config,
  }));

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

  const registrationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many registration attempts. Please try again later." },
  });

  app.use("/api", apiLimiter);
  app.use("/api/members/register", registrationLimiter);
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
      billingService,
      config,
    })
  );

  log.info("All routes registered — app fully ready.");

  // ── Scheduled cleanup of old uploaded files ───────────────────────────────
  startUploadsCleaner(uploadsDir);

  // ── Scheduled cleanup of old DB images (every 6 hours, delete >30 days) ──
  if (store?.deleteOldImages) {
    const IMAGE_CLEANUP_INTERVAL = 6 * 60 * 60 * 1000;
    const IMAGE_MAX_AGE_DAYS = Number(process.env.IMAGE_MAX_AGE_DAYS) || 30;
    const sweepImages = async () => {
      try {
        const deleted = await store.deleteOldImages(IMAGE_MAX_AGE_DAYS);
        if (deleted > 0) log.info({ deleted, maxAgeDays: IMAGE_MAX_AGE_DAYS }, "DB image cleanup completed");
      } catch (err) {
        log.error({ err: err?.message }, "DB image cleanup error");
      }
    };
    setTimeout(sweepImages, 60 * 1000);
    setInterval(sweepImages, IMAGE_CLEANUP_INTERVAL);
  }

  // ── Global error handler ──────────────────────────────────────────────────
  app.use((err, _req, res, _next) => {
    log.error({ err }, "Unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  return { app, server };
}

module.exports = {
  createServer,
};
