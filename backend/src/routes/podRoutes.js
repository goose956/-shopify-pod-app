const express = require("express");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const log = require("../utils/logger");

/**
 * Sanitize user input: strip HTML tags and limit length.
 * Prevents XSS in data that may be sent to Shopify or rendered in admin.
 */
function sanitize(input, maxLength = 2000) {
  return String(input || "")
    .replace(/<[^>]*>/g, "")    // strip HTML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") // strip control chars
    .trim()
    .slice(0, maxLength);
}

function createPodRouter({ authService, memberAuthService, memberRepository, analyticsService, designRepository, productRepository, settingsRepository, pipelineService, assetStorageService, publishService, printfulMockupService, billingService, config }) {
  const router = express.Router();
  const uploadsDir = config?.storage?.uploadsDir || path.join(__dirname, "..", "..", "data", "uploads");

  /** Download an external http(s) URL to DB (or local uploads dir as fallback) and return an image path. */
  async function persistImageUrl(imageUrl, shopDomain) {
    if (!imageUrl || typeof imageUrl !== "string") return imageUrl;
    // Already persisted to DB or local uploads
    if (imageUrl.startsWith("/images/") || imageUrl.startsWith("/uploads/")) return imageUrl;
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) return imageUrl;
    try {
      // Try DB storage first
      if (pipelineService?.store?.saveImage && shopDomain) {
        const resp = await fetch(imageUrl);
        if (!resp.ok) return imageUrl;
        const ct = resp.headers.get("content-type") || "image/png";
        const buffer = Buffer.from(await resp.arrayBuffer());
        const id = randomUUID();
        await pipelineService.store.saveImage({ id, shopDomain, data: buffer, mimeType: ct });
        log.info({ id }, "Persisted external image to database");
        return `/images/${id}`;
      }
      // Fallback: local disk
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const resp = await fetch(imageUrl);
      if (!resp.ok) return imageUrl;
      const ct = resp.headers.get("content-type") || "image/png";
      const ext = ct.includes("webp") ? "webp" : ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "png";
      const filename = `${randomUUID()}.${ext}`;
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, Buffer.from(await resp.arrayBuffer()));
      log.info({ filename }, "Persisted external image to local uploads");
      return `/uploads/${filename}`;
    } catch (err) {
      log.error({ err: err?.message, imageUrl }, "Failed to persist image URL");
      return imageUrl;
    }
  }

  // Env-var defaults for API keys (fallback when not saved in DB settings)
  const envDefaults = config?.defaults || {};

  /** Merge saved settings with env-var defaults. DB settings take priority. */
  function effectiveKey(savedValue, envDefault) {
    return String(savedValue || envDefault || "").trim();
  }

  /** Get effective settings for a shop, merging env defaults */
  function getEffectiveSettings(shopDomain) {
    const s = settingsRepository.findByShop(shopDomain) || {};
    return {
      ...s,
      openAiApiKey: effectiveKey(s.openAiApiKey, envDefaults.openAiApiKey),
      printfulApiKey: effectiveKey(s.printfulApiKey, envDefaults.printfulApiKey),
      keiAiApiKey: effectiveKey(s.keiAiApiKey, envDefaults.kieApiKey),
      stabilityApiKey: effectiveKey(s.stabilityApiKey, envDefaults.stabilityApiKey),
    };
  }

  async function resolveSession(req) {
    const shopifySession = await authService.validateRequest(req);
    if (shopifySession?.shopDomain) {
      log.info({ shopDomain: shopifySession.shopDomain, subject: shopifySession.subject, authType: "shopify" }, "Session resolved");
      return {
        ...shopifySession,
        authType: "shopify",
      };
    }

    const memberSession = await memberAuthService.validateRequest(req);
    if (memberSession?.shopDomain) {
      log.info({ shopDomain: memberSession.shopDomain, authType: "member" }, "Session resolved");
      return {
        ...memberSession,
        subject: memberSession.memberId,
        authType: "member",
      };
    }

    log.warn({ path: req.path, hasAuth: Boolean(req.headers.authorization) }, "Session resolution failed — no valid token");
    return null;
  }

  async function requireSession(req, res) {
    const session = await resolveSession(req);
    if (!session?.shopDomain) {
      res.status(401).json({ error: "Invalid or missing session token" });
      return null;
    }

    return session;
  }

  // ── Re-auth: returns the OAuth install URL for the current shop ──────────
  router.get("/reauth", async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.shopDomain) {
      return res.status(401).json({ error: "No session" });
    }
    const shop = session.shopDomain;
    const host = (config.shopify.hostName || "").replace(/^https?:\/\//, "");
    const authUrl = `https://${host}/auth?shop=${encodeURIComponent(shop)}`;
    return res.json({ authUrl, shop });
  });

  // ── Token health check ────────────────────────────────────────────────────
  router.get("/token-health", async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.shopDomain) {
      return res.status(401).json({ error: "No session", hint: "Open this from within Shopify admin" });
    }

    const shopSettings = settingsRepository.findByShop(session.shopDomain);
    const token = shopSettings?.shopifyAccessToken;

    const result = {
      sessionShopDomain: session.shopDomain,
      tokenFound: Boolean(token),
      shopifyApiCheck: null,
    };

    // Validate the token against Shopify GraphQL API
    if (token) {
      try {
        const apiVersion = config.shopify.apiVersion;
        const resp = await fetch(
          `https://${session.shopDomain}/admin/api/${apiVersion}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": token,
            },
            body: JSON.stringify({ query: "{ shop { name } }" }),
          }
        );
        if (resp.ok) {
          const data = await resp.json();
          result.shopifyApiCheck = { valid: true, shopName: data?.data?.shop?.name };
        } else {
          result.shopifyApiCheck = { valid: false, status: resp.status };
        }
      } catch (err) {
        result.shopifyApiCheck = { valid: false, error: err.message };
      }
    }

    return res.json(result);
  });

  // ── Verify token scopes against Shopify API directly ────────────────────
  // PRODUCTION GUARD: disabled in production to prevent token/scope leakage
  router.get("/verify-scopes", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not available in production" });
    }
    const session = await resolveSession(req);
    if (!session?.shopDomain) {
      return res.status(401).json({ error: "No session" });
    }

    const shopSettings = settingsRepository.findByShop(session.shopDomain);
    const token = shopSettings?.shopifyAccessToken;
    if (!token) {
      return res.json({ error: "No token stored", shopDomain: session.shopDomain });
    }

    try {
      // Query Shopify's access_scopes endpoint
      const resp = await fetch(
        `https://${session.shopDomain}/admin/oauth/access_scopes.json`,
        { headers: { "X-Shopify-Access-Token": token } }
      );
      const data = await resp.json();
      const scopes = data?.access_scopes?.map(s => s.handle) || [];

      res.json({
        shopDomain: session.shopDomain,
        tokenPrefix: token.slice(0, 8) + "...",
        httpStatus: resp.status,
        grantedScopes: scopes,
        hasWriteProducts: scopes.includes("write_products"),
        hasReadProducts: scopes.includes("read_products"),
        configuredScopes: config.shopify.scopes,
        raw: data,
      });
    } catch (err) {
      res.json({ error: err.message, shopDomain: session.shopDomain });
    }
  });

  // ── Debug: check OAuth token status for current session ─────────────────
  // PRODUCTION GUARD: disabled in production to prevent internal state leakage
  router.get("/debug-auth", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not available in production" });
    }
    const session = await resolveSession(req);
    if (!session?.shopDomain) {
      return res.status(401).json({ error: "No session" });
    }

    // Also read directly from Postgres to check persistence
    let pgDirect = { storeType: "unknown", hasPool: false };
    try {
      const store = settingsRepository.store;
      pgDirect.storeType = store?.constructor?.name || typeof store;
      pgDirect.hasPool = Boolean(store?.pool);
      if (store?.pool) {
        const result = await store.pool.query("SELECT data FROM app_data WHERE id = 1");
        pgDirect.rowCount = result.rows.length;
        if (result.rows.length > 0) {
          const pgSettings = result.rows[0].data?.settings || [];
          const realShops = pgSettings.filter(s => !s.shopDomain?.startsWith("_nonce:"));
          pgDirect.totalSettings = pgSettings.length;
          pgDirect.shops = realShops.map(s => ({
            domain: s.shopDomain,
            hasToken: Boolean(s.shopifyAccessToken),
            tokenPrefix: s.shopifyAccessToken ? s.shopifyAccessToken.slice(0, 8) + "..." : "none",
            scopes: s.shopifyScopes || "none",
          }));
        }
      }
    } catch (pgErr) {
      pgDirect.error = pgErr.message;
    }

    const shopSettings = settingsRepository.findByShop(session.shopDomain);
    const allSettings = settingsRepository.store?.read?.()?.settings || [];
    const shopDomains = allSettings
      .filter(s => !s.shopDomain?.startsWith("_nonce:"))
      .map(s => ({
        domain: s.shopDomain,
        hasToken: Boolean(s.shopifyAccessToken),
        tokenPrefix: s.shopifyAccessToken ? s.shopifyAccessToken.slice(0, 8) + "..." : "none",
        grantedScopes: s.shopifyScopes || "unknown",
        installedAt: s.installedAt,
      }));

    const configuredScopes = config?.shopify?.scopes?.join(",") || "unknown";

    res.json({
      sessionShopDomain: session.shopDomain,
      authType: session.authType,
      tokenFound: Boolean(shopSettings?.shopifyAccessToken),
      tokenPrefix: shopSettings?.shopifyAccessToken ? shopSettings.shopifyAccessToken.slice(0, 8) + "..." : "none",
      grantedScopes: shopSettings?.shopifyScopes || "unknown",
      configuredScopes,
      allShops: shopDomains,
      pgDirect,
    });
  });

  // ── Manual token set (requires SETUP_SECRET, dev/test only) ────────────────
  router.post("/set-shopify-token", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not available in production" });
    }
    const session = await resolveSession(req);
    if (!session?.shopDomain) {
      return res.status(401).json({ error: "No session" });
    }

    // Reject unless authenticated via SETUP_SECRET
    if (session.subject !== "setup-admin") {
      return res.status(403).json({ error: "This endpoint requires SETUP_SECRET authentication" });
    }

    const { shop, token } = req.body || {};
    const targetShop = String(shop || session.shopDomain).trim();
    const accessToken = String(token || "").trim();

    if (!accessToken) {
      return res.status(400).json({ error: "Missing 'token' in body" });
    }

    settingsRepository.upsertByShop(targetShop, {
      shopifyAccessToken: accessToken,
      installedAt: Date.now(),
    });

    // Flush to Postgres so it survives restarts
    try {
      await settingsRepository.flush();
      log.info({ shop: targetShop }, "Token flushed to PostgreSQL");
    } catch (flushErr) {
      log.error({ shop: targetShop, err: flushErr.message }, "Token flush to PostgreSQL FAILED");
    }

    // Verify
    const saved = settingsRepository.findByShop(targetShop);
    res.json({
      ok: true,
      shop: targetShop,
      tokenSaved: Boolean(saved?.shopifyAccessToken),
      tokenPrefix: saved?.shopifyAccessToken ? saved.shopifyAccessToken.slice(0, 8) + "..." : "none",
    });
  });

  // ── Reset OAuth (delete stored token so re-auth requests fresh scopes) ────
  router.post("/reset-oauth", async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.shopDomain) {
      return res.status(401).json({ error: "No session" });
    }

    const targetShop = String(req.body?.shop || session.shopDomain).trim();

    // Security: only allow resetting own shop's token
    if (targetShop !== session.shopDomain) {
      return res.status(403).json({ error: "Cannot reset OAuth for a different shop." });
    }

    const before = settingsRepository.findByShop(targetShop);

    // Clear token + scopes but keep other settings
    settingsRepository.upsertByShop(targetShop, {
      shopifyAccessToken: "",
      shopifyScopes: "",
    });

    try {
      await settingsRepository.flush();
    } catch (e) {
      log.error({ err: e.message }, "reset-oauth flush error");
    }

    const oauthUrl = `https://${config.shopify.hostName.replace(/^https?:\/\//, "")}/auth?shop=${encodeURIComponent(targetShop)}`;

    res.json({
      ok: true,
      shop: targetShop,
      previousTokenPrefix: before?.shopifyAccessToken ? before.shopifyAccessToken.slice(0, 8) + "..." : "none",
      previousScopes: before?.shopifyScopes || "none",
      tokenCleared: true,
      oauthUrl,
      message: `Token cleared. Visit the oauthUrl to re-authorize with scopes: ${config.shopify.scopes.join(",")}`,
    });
  });

  router.post("/members/register", async (req, res) => {
    try {
      const member = await memberAuthService.register({
        email: sanitize(req.body?.email, 254),
        fullName: sanitize(req.body?.fullName, 100),
        password: String(req.body?.password || ""),
      });
      return res.status(201).json({ member });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Failed to register member" });
    }
  });

  router.post("/members/login", async (req, res) => {
    try {
      const result = await memberAuthService.login({
        email: req.body?.email,
        password: req.body?.password,
      });
      return res.json(result);
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : "Failed to login" });
    }
  });

  router.get("/members/me", async (req, res) => {
    const memberSession = await memberAuthService.validateRequest(req);
    if (!memberSession?.memberId) {
      return res.status(401).json({ error: "Invalid or missing member token" });
    }

    const member = memberRepository.findById(memberSession.memberId);
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    return res.json({
      member: memberAuthService.sanitizeMember(member),
    });
  });

  router.get("/admin/analytics", async (req, res) => {
    const shopSession = await authService.validateRequest(req);
    if (!shopSession?.shopDomain) {
      return res.status(401).json({ error: "Invalid or missing Shopify session token" });
    }

    // Only show members that belong to this shop (by shopDomain on their designs)
    const allDesigns = designRepository.listByShop(shopSession.shopDomain);
    const published = allDesigns.filter((item) => item.status === "published").length;
    const designCountsByMember = designRepository.countByMember(shopSession.shopDomain);

    // Scope members to only those who have created designs in this shop
    const shopMemberIds = new Set(Object.keys(designCountsByMember));
    const allMembers = memberRepository.list().filter((m) => shopMemberIds.has(m.id));

    return res.json({
      visitors: analyticsService.getSummary(),
      totals: {
        members: allMembers.length,
        designs: allDesigns.length,
        publishedDesigns: published,
      },
      recentMembers: allMembers.slice(0, 8).map((item) => ({
        ...memberAuthService.sanitizeMember(item),
        designCount: designCountsByMember[item.id] || 0,
      })),
    });
  });

  // Mask API keys for safe display (show first 4 + last 4 chars)
  function maskKey(key) {
    const k = String(key || "");
    if (k.length <= 8) return k ? "****" : "";
    return k.slice(0, 4) + "****" + k.slice(-4);
  }

  router.get("/settings", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    const settings = getEffectiveSettings(session.shopDomain);
    const isAdmin = session.subject === "setup-admin";
    return res.json({
      imageProviderDefault: "openai",
      // Only expose masked keys to admin users
      ...(isAdmin ? {
        keiAiApiKey: maskKey(settings.keiAiApiKey),
        openAiApiKey: maskKey(settings.openAiApiKey),
        kieGenerateUrl: settings.kieGenerateUrl || "https://api.kie.ai/api/v1/gpt4o-image/generate",
        kieEditUrl: settings.kieEditUrl || "https://api.kie.ai/api/v1/gpt4o-image/generate",
        printfulApiKey: maskKey(settings.printfulApiKey),
      } : {}),
      // Tell the frontend which keys are configured (without exposing them)
      hasOpenAiKey: Boolean(settings.openAiApiKey),
      hasKeiAiKey: Boolean(settings.keiAiApiKey),
      hasPrintfulKey: Boolean(settings.printfulApiKey),
      hasShopifyToken: Boolean(settings.shopifyAccessToken),
      isAdmin,
      updatedAt: settings.updatedAt || null,
    });
  });

  router.put("/settings", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    const existing = settingsRepository.findByShop(session.shopDomain);

    // Helper: if the submitted value looks like a masked key (contains ****),
    // keep the existing stored value instead of overwriting with the mask.
    function resolveKey(field, submitted, fallback) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        return String(fallback || "").trim();
      }
      const val = String(submitted || "").trim();
      // If user submitted the masked version back, keep existing
      if (val.includes("****")) return String(fallback || "").trim();
      return val;
    }

    const keiAiApiKey = resolveKey("keiAiApiKey", req.body?.keiAiApiKey, existing?.keiAiApiKey);
    const openAiApiKey = resolveKey("openAiApiKey", req.body?.openAiApiKey, existing?.openAiApiKey);
    const printfulApiKey = resolveKey("printfulApiKey", req.body?.printfulApiKey, existing?.printfulApiKey);

    const hasKieGenerateUrl = Object.prototype.hasOwnProperty.call(req.body || {}, "kieGenerateUrl");
    const hasKieEditUrl = Object.prototype.hasOwnProperty.call(req.body || {}, "kieEditUrl");
    const kieGenerateUrl = (hasKieGenerateUrl
      ? String(req.body?.kieGenerateUrl || "").trim()
      : String(existing?.kieGenerateUrl || "").trim()) || "https://api.kie.ai/api/v1/gpt4o-image/generate";
    const kieEditUrl = (hasKieEditUrl
      ? String(req.body?.kieEditUrl || "").trim()
      : String(existing?.kieEditUrl || "").trim()) || "https://api.kie.ai/api/v1/gpt4o-image/generate";

    const settings = settingsRepository.upsertByShop(session.shopDomain, {
      keiAiApiKey,
      openAiApiKey,
      kieGenerateUrl,
      kieEditUrl,
      printfulApiKey,
    });

    return res.json({
      imageProviderDefault: "openai",
      keiAiApiKey: maskKey(settings.keiAiApiKey),
      openAiApiKey: maskKey(settings.openAiApiKey),
      kieGenerateUrl: settings.kieGenerateUrl,
      kieEditUrl: settings.kieEditUrl,
      printfulApiKey: maskKey(settings.printfulApiKey),
      hasOpenAiKey: Boolean(settings.openAiApiKey),
      hasKeiAiKey: Boolean(settings.keiAiApiKey),
      hasPrintfulKey: Boolean(settings.printfulApiKey),
      hasShopifyToken: Boolean(settings.shopifyAccessToken),
      updatedAt: settings.updatedAt,
    });
  });

  router.post("/settings/test-kie", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    try {
      const settings = getEffectiveSettings(session.shopDomain);
      const keiAiApiKey = String(req.body?.keiAiApiKey || settings?.keiAiApiKey || "").trim();
      const kieGenerateUrl = String(req.body?.kieGenerateUrl || settings?.kieGenerateUrl || "").trim();
      const result = await pipelineService.generateDesignImage({
        artworkPrompt: "test image prompt for connectivity",
        keiAiApiKey,
        kieGenerateUrl,
        maxWaitMs: 15000,
        pollIntervalMs: 2000,
        shopDomain: session.shopDomain,
      });

      return res.json({
        provider: result.provider,
        message: result.providerMessage,
        imageUrl: result.imageUrl,
        endpoint: kieGenerateUrl || "https://api.kie.ai/api/v1/gpt4o-image/generate",
      });
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to test KIE connection",
      });
    }
  });

  router.post("/settings/test-openai", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    try {
      const settings = getEffectiveSettings(session.shopDomain);
      const openAiApiKey = String(req.body?.openAiApiKey || settings?.openAiApiKey || "").trim();

      const copyResult = await pipelineService.generateListingCopy({
        prompt: "test listing copy for shamrock mug",
        productType: "mug",
        openAiApiKey,
      });

      // Also probe whether image generation is available on this key
      let imageProvider = "not-tested";
      let imageMessage = "";
      if (pipelineService.isUsableApiKey(openAiApiKey)) {
        const probeResponse = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${openAiApiKey}` },
          body: JSON.stringify({ model: "gpt-image-1", prompt: "a simple test circle", size: "1024x1024", n: 1 }),
        }).catch(() => null);

        if (!probeResponse) {
          imageProvider = "error";
          imageMessage = "Network error reaching OpenAI image API";
        } else if (probeResponse.ok) {
          imageProvider = "gpt-image-1";
          imageMessage = "gpt-image-1 is available on this key";
        } else {
          // Try dall-e-3 as fallback check
          const fallbackResponse = await fetch("https://api.openai.com/v1/models/dall-e-3", {
            headers: { Authorization: `Bearer ${openAiApiKey}` },
          }).catch(() => null);
          if (fallbackResponse?.ok) {
            imageProvider = "dall-e-3";
            imageMessage = `gpt-image-1 not on this tier (${probeResponse.status}) â€” dall-e-3 will be used`;
          } else {
            const errBody = await probeResponse.json().catch(() => ({}));
            imageProvider = "error";
            imageMessage = errBody?.error?.message || `Image generation unavailable (${probeResponse.status})`;
          }
        }
      }

      return res.json({
        provider: copyResult.provider,
        message: copyResult.providerMessage,
        sampleTitle: copyResult.copy?.title || "",
        imageProvider,
        imageMessage,
      });
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to test OpenAI connection",
      });
    }
  });

  router.post("/analyze-image", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    // ── Billing enforcement ──────────────────────────────────────────
    if (billingService) {
      const check = billingService.canPerformAction(session.shopDomain, "analyze");
      if (!check.allowed) {
        return res.status(403).json({
          error: check.isOnTrial
            ? `Trial credit limit reached (${check.current}/${check.limit}).`
            : `Monthly credit limit reached (${check.current}/${check.limit}). Upgrade for more.`,
          limitReached: true, isOnTrial: check.isOnTrial || false, usage: check,
        });
      }
    }

    const imageBase64 = String(req.body?.imageBase64 || "").trim();
    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    try {
      const settings = getEffectiveSettings(session.shopDomain);
      const result = await pipelineService.analyzeProductImage({
        imageBase64,
        openAiApiKey: settings?.openAiApiKey || "",
      });

      // Record credit usage for image analysis
      if (billingService) billingService.recordUsage(session.shopDomain);

      return res.json({ description: result.description });
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to analyze image",
      });
    }
  });

  router.post("/design-preview", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    // ── Billing enforcement: check design quota ──────────────────────
    if (billingService) {
      const check = billingService.canPerformAction(session.shopDomain, "design");
      if (!check.allowed) {
        const msg = check.isOnTrial
          ? `Trial credit limit reached (${check.current}/${check.limit}). Your full ${check.fullLimit} credits unlock after the trial.`
          : `Monthly design limit reached (${check.current}/${check.limit}). Upgrade to Pro for more.`;
        return res.status(403).json({
          error: msg,
          limitReached: true,
          isOnTrial: check.isOnTrial || false,
          usage: check,
        });
      }
    }

    const prompt = sanitize(req.body?.prompt, 5000);
    const productType = sanitize(req.body?.productType || "mug", 50).toLowerCase();
    const imageShape = sanitize(req.body?.imageShape || "square", 20).toLowerCase();
    const publishImmediately = Boolean(req.body?.publishImmediately);
    const customProductImage = req.body?.customProductImage || null; // base64 data URL

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    try {
      const settings = getEffectiveSettings(session.shopDomain);

      // If user uploaded a custom product image, save it to DB
      let customProductImageUrl = null;
      if (customProductImage && typeof customProductImage === "string" && customProductImage.startsWith("data:image/")) {
        const match = customProductImage.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          const mimeType = match[1];
          const base64Data = match[2];
          const imgId = require("crypto").randomUUID();
          await store.saveImage({ id: imgId, shopDomain: session.shopDomain, data: Buffer.from(base64Data, "base64"), mimeType });
          customProductImageUrl = `/images/${imgId}`;
          log.info({ customProductImageUrl, mimeType }, "Saved custom product image to DB");
        }
      }

      // Generate ONLY the raw isolated artwork (mockup comes later when user approves)
      const artworkPrompt = await pipelineService.buildArtworkPrompt({ prompt, productType });
      let designResult = await pipelineService.generateDesignImage({
        artworkPrompt,
        openAiApiKey: settings?.openAiApiKey || "",
        keiAiApiKey: settings?.keiAiApiKey || "",
        kieGenerateUrl: settings?.kieGenerateUrl,
        imageShape,
        maxWaitMs: 30000,
        pollIntervalMs: 2500,
        shopDomain: session.shopDomain,
      });
      const rawArtworkUrl = designResult.imageUrl;

      const design = pipelineService.createDesignRecord({
        shopDomain: session.shopDomain,
        prompt,
        productType,
        publishImmediately,
        artworkPrompt,
        designImageUrl: rawArtworkUrl,
        createdBy: session.subject || session.memberId || null,
      });
      design.rawArtworkUrl = rawArtworkUrl;
      if (customProductImageUrl) {
        design.customProductImageUrl = customProductImageUrl;
      }

      const previewAsset = assetStorageService.saveAsset({
        designId: design.id,
        shopDomain: session.shopDomain,
        type: "artwork-raw",
        role: "base",
        url: rawArtworkUrl,
        promptSnapshot: artworkPrompt,
      });

      const savedDesign = designRepository.create({
        ...design,
        currentDesignAssetId: previewAsset.id,
      });

      // Record credit usage
      if (billingService) {
        billingService.recordUsage(session.shopDomain);
      }

      return res.json({
        designId: savedDesign.id,
        rawArtworkUrl,
        provider: {
          designImage: designResult.provider,
          message: designResult.providerMessage,
        },
      });
    } catch (error) {
      log.error({ err: error?.message, stack: error?.stack?.split?.('\n')?.slice(0, 5) }, "design-preview route error");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to generate design preview",
      });
    }
  });

  // Printful product catalog with images
  router.get("/printful-catalog", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    try {
      const settings = getEffectiveSettings(session.shopDomain);
      if (!settings?.printfulApiKey) {
        return res.json({ products: [], source: "no-key" });
      }

      const catalog = await printfulMockupService.getProductCatalog(settings.printfulApiKey);
      return res.json(catalog);
    } catch (error) {
      log.error({ err: error?.message }, "Failed to fetch product catalog");
      return res.status(500).json({ error: "Failed to fetch product catalog" });
    }
  });

  // Generate product mockup from approved artwork
  router.post("/generate-mockup", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    // ── Billing enforcement ──────────────────────────────────────────
    if (billingService) {
      const check = billingService.canPerformAction(session.shopDomain, "mockup");
      if (!check.allowed) {
        return res.status(403).json({
          error: check.isOnTrial
            ? `Trial credit limit reached (${check.current}/${check.limit}).`
            : `Monthly credit limit reached (${check.current}/${check.limit}). Upgrade for more.`,
          limitReached: true, isOnTrial: check.isOnTrial || false, usage: check,
        });
      }
    }

    const designId = String(req.body?.designId || "").trim();
    if (!designId) {
      return res.status(400).json({ error: "designId is required" });
    }

    const design = designRepository.findById(designId);
    if (!design || design.shopDomain !== session.shopDomain) {
      return res.status(404).json({ error: "Design not found" });
    }

    const rawArtworkUrl = design.rawArtworkUrl || design.previewImageUrl;
    if (!rawArtworkUrl) {
      return res.status(400).json({ error: "No artwork found to create mockup from" });
    }

    // Check if the reference file actually exists on disk
    if (rawArtworkUrl.startsWith("/uploads/")) {
      const localPath = path.join(uploadsDir, path.basename(rawArtworkUrl));
      const fileExists = fs.existsSync(localPath);
      const fileSize = fileExists ? fs.statSync(localPath).size : 0;
      log.info({ rawArtworkUrl, localPath, fileExists, fileSizeKB: Math.round(fileSize / 1024) }, "Mockup: reference file check");
      if (!fileExists) {
        log.error({ rawArtworkUrl, localPath }, "Mockup: reference artwork file NOT FOUND on disk");
        return res.status(400).json({ error: "Artwork file no longer exists on server. Please regenerate your design." });
      }
    }

    try {
      const settings = getEffectiveSettings(session.shopDomain);
      const imageShape = String(req.body?.imageShape || "square").trim().toLowerCase();
      const printfulProductId = req.body?.printfulProductId || null;

      // If user uploaded a custom product image, use dual-image mockup generation
      if (design.customProductImageUrl) {
        log.info({ customProductImageUrl: design.customProductImageUrl, rawArtworkUrl }, "Mockup: using custom product image");
        const mockupPrompt = `Place the artwork design from the first image onto the product shown in the second image. Create a realistic, professional product mockup. The design should appear naturally on the product surface, with proper perspective and lighting that matches the product photo.`;
        const customMockupUrl = await pipelineService.generateMockupWithCustomProduct({
          artworkUrl: rawArtworkUrl,
          customProductImageUrl: design.customProductImageUrl,
          prompt: mockupPrompt,
          openAiApiKey: settings?.openAiApiKey || "",
          imageShape,
          shopDomain: session.shopDomain,
        });

        if (customMockupUrl) {
          assetStorageService.saveAsset({
            designId,
            shopDomain: session.shopDomain,
            type: "design-preview",
            role: "mockup",
            url: customMockupUrl,
            promptSnapshot: mockupPrompt,
          });

          designRepository.update(designId, {
            previewImageUrl: customMockupUrl,
            mockupImageUrl: customMockupUrl,
            updatedAt: Date.now(),
          });

          if (billingService) billingService.recordUsage(session.shopDomain);

          return res.json({
            designId,
            designImageUrl: customMockupUrl,
            provider: {
              designImage: "openai",
              message: "Custom product mockup generated with OpenAI.",
            },
          });
        }
        log.warn({}, "Custom product mockup failed, falling back to standard flow");
      }

      // Try Printful first (free, professional mockups)
      if (printfulMockupService && settings?.printfulApiKey) {
        log.info({ productType: design.productType, printfulProductId: printfulProductId || undefined }, "Trying Printful for mockup generation");
        const printfulResult = await printfulMockupService.generateMockup({
          printfulApiKey: settings.printfulApiKey,
          artworkUrl: rawArtworkUrl,
          productType: design.productType,
          printfulProductId,
          maxWaitMs: 60000,
          pollIntervalMs: 3000,
        });

        if (printfulResult.provider === "printful" && printfulResult.mockupUrls.length > 0) {
          const designImageUrl = printfulResult.mockupUrls[0];

          assetStorageService.saveAsset({
            designId,
            shopDomain: session.shopDomain,
            type: "design-preview",
            role: "mockup",
            url: designImageUrl,
            promptSnapshot: "Printful mockup",
          });

          designRepository.update(designId, {
            previewImageUrl: designImageUrl,
            mockupImageUrl: designImageUrl,
            updatedAt: Date.now(),
          });

          // Record credit usage for Printful mockup
          if (billingService) billingService.recordUsage(session.shopDomain);

          return res.json({
            designId,
            designImageUrl,
            allMockupUrls: printfulResult.mockupUrls,
            provider: {
              designImage: printfulResult.provider,
              message: printfulResult.providerMessage,
            },
          });
        }
        log.warn({ providerMessage: printfulResult.providerMessage }, "Printful unavailable, falling back to AI");
      }

      // Fallback: AI-generated mockup
      log.info({ rawArtworkUrl, productType: design.productType, imageShape }, "Mockup: attempting AI-generated mockup with reference image");
      const mockupPrompt = pipelineService.buildMockupPrompt({ productType: design.productType, designConcept: design.prompt });

      let mockupResult = await pipelineService.generateDesignImage({
        artworkPrompt: mockupPrompt,
        openAiApiKey: settings?.openAiApiKey || "",
        keiAiApiKey: settings?.keiAiApiKey || "",
        kieGenerateUrl: settings?.kieGenerateUrl,
        referenceImageUrl: rawArtworkUrl,
        imageShape,
        maxWaitMs: 30000,
        pollIntervalMs: 2500,
        shopDomain: session.shopDomain,
      });

      const designImageUrl = mockupResult.imageUrl;

      assetStorageService.saveAsset({
        designId,
        shopDomain: session.shopDomain,
        type: "design-preview",
        role: "mockup",
        url: designImageUrl,
        promptSnapshot: mockupPrompt,
      });

      designRepository.update(designId, {
        previewImageUrl: designImageUrl,
        mockupImageUrl: designImageUrl,
        updatedAt: Date.now(),
      });

      // Record credit usage for mockup generation
      if (billingService) billingService.recordUsage(session.shopDomain);

      return res.json({
        designId,
        designImageUrl,
        provider: {
          designImage: mockupResult.provider,
          message: mockupResult.providerMessage,
        },
      });
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to generate product mockup",
      });
    }
  });

  router.post("/revise-design", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    // ── Billing enforcement ──────────────────────────────────────────
    if (billingService) {
      const check = billingService.canPerformAction(session.shopDomain, "revision");
      if (!check.allowed) {
        return res.status(403).json({
          error: check.isOnTrial
            ? `Trial credit limit reached (${check.current}/${check.limit}).`
            : `Monthly credit limit reached (${check.current}/${check.limit}). Upgrade for more.`,
          limitReached: true, isOnTrial: check.isOnTrial || false, usage: check,
        });
      }
    }

    const designId = String(req.body?.designId || "").trim();
    const amendment = String(req.body?.amendment || "").trim();

    if (!designId || !amendment) {
      return res.status(400).json({ error: "designId and amendment are required" });
    }

    const design = designRepository.findById(designId);
    if (!design || design.shopDomain !== session.shopDomain) {
      return res.status(404).json({ error: "Design not found" });
    }

    try {
      const settings = getEffectiveSettings(session.shopDomain);
      const artworkPrompt = await pipelineService.buildArtworkPrompt({
        prompt: design.prompt,
        productType: design.productType,
        amendment,
      });
      // Revise the raw artwork (not the mockup)
      const referenceUrl = design.rawArtworkUrl || design.previewImageUrl;
      const revisionPrompt = `Edit the provided artwork design. Keep the same overall composition, subject, and visual style. Apply only this change: ${amendment}`;
      let designResult = await pipelineService.generateDesignImage({
        artworkPrompt: revisionPrompt,
        openAiApiKey: settings?.openAiApiKey || "",
        keiAiApiKey: settings?.keiAiApiKey || "",
        kieGenerateUrl: settings?.kieEditUrl || settings?.kieGenerateUrl,
        referenceImageUrl: referenceUrl,
        maxWaitMs: 20000,
        pollIntervalMs: 2500,
        shopDomain: session.shopDomain,
      });

      if (designResult.provider !== "openai" && designResult.provider !== "kie") {
        const providerMessage = String(designResult.providerMessage || "").toLowerCase();
        const shouldRetryWithoutReference =
          providerMessage.includes("size exceeds limit") ||
          providerMessage.includes("timed out");

        designResult = await pipelineService.generateDesignImage({
          artworkPrompt: revisionPrompt,
          openAiApiKey: settings?.openAiApiKey || "",
          keiAiApiKey: settings?.keiAiApiKey || "",
          kieGenerateUrl: settings?.kieEditUrl || settings?.kieGenerateUrl,
          referenceImageUrl: shouldRetryWithoutReference ? undefined : referenceUrl,
          maxWaitMs: 70000,
          pollIntervalMs: 3000,
          shopDomain: session.shopDomain,
        });
      }

      if (designResult.provider !== "openai" && designResult.provider !== "kie") {
        return res.status(504).json({
          error: "Revision image generation did not complete in time. Please retry.",
          provider: {
            designImage: designResult.provider,
            message: designResult.providerMessage,
          },
        });
      }

      const designImageUrl = designResult.imageUrl;

      const revisedAsset = assetStorageService.saveAsset({
        designId,
        shopDomain: session.shopDomain,
        type: "design-preview",
        role: "revision",
        url: designImageUrl,
        promptSnapshot: artworkPrompt,
      });

      designRepository.update(designId, {
        artworkPrompt,
        previewImageUrl: designImageUrl,
        rawArtworkUrl: designImageUrl,
        currentDesignAssetId: revisedAsset.id,
        revisionCount: Number(design.revisionCount || 0) + 1,
        status: "preview_ready",
        updatedAt: Date.now(),
      });

      // Record credit usage for revision
      if (billingService) billingService.recordUsage(session.shopDomain);

      return res.json({
        designId,
        designImageUrl,
        rawArtworkUrl: designImageUrl,
        provider: {
          designImage: designResult.provider,
          message: designResult.providerMessage,
        },
      });
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to revise design",
      });
    }
  });

  // ── Save canvas-edited artwork (base64 PNG from the design editor) ──────
  router.post("/save-edited-artwork", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const designId = String(req.body?.designId || "").trim();
    const imageData = req.body?.imageData; // base64 data URL

    if (!designId || !imageData) {
      return res.status(400).json({ error: "designId and imageData are required" });
    }

    const design = designRepository.findById(designId);
    if (!design || design.shopDomain !== session.shopDomain) {
      return res.status(404).json({ error: "Design not found" });
    }

    try {
      // Strip data URL prefix: "data:image/png;base64,..."
      const base64Match = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!base64Match) {
        return res.status(400).json({ error: "Invalid image data format. Expected base64 data URL." });
      }
      const ext = base64Match[1] === "jpeg" ? "jpg" : base64Match[1];
      const mimeType = ext === "jpg" ? "image/jpeg" : `image/${base64Match[1]}`;
      const buffer = Buffer.from(base64Match[2], "base64");

      let editedUrl;
      // Try DB storage first
      if (pipelineService?.store?.saveImage) {
        const id = randomUUID();
        await pipelineService.store.saveImage({ id, shopDomain: session.shopDomain, data: buffer, mimeType });
        editedUrl = `/images/${id}`;
        log.info({ id, sizeKB: (buffer.length / 1024).toFixed(1) }, "Saved edited artwork from canvas editor to database");
      } else {
        // Fallback: local disk
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const filename = `${randomUUID()}-edited.${ext}`;
        const filePath = path.join(uploadsDir, filename);
        fs.writeFileSync(filePath, buffer);
        editedUrl = `/uploads/${filename}`;
        log.info({ filename, sizeKB: (buffer.length / 1024).toFixed(1) }, "Saved edited artwork from canvas editor");
      }

      // Save as asset
      const editedAsset = assetStorageService.saveAsset({
        designId,
        shopDomain: session.shopDomain,
        type: "design-preview",
        role: "canvas-edit",
        url: editedUrl,
        promptSnapshot: "Canvas editor edit",
      });

      // Update design record
      designRepository.update(designId, {
        previewImageUrl: editedUrl,
        rawArtworkUrl: editedUrl,
        currentDesignAssetId: editedAsset.id,
        mockupImageUrl: null, // Clear mockup since artwork changed
        status: "preview_ready",
        updatedAt: Date.now(),
      });

      return res.json({
        designId,
        rawArtworkUrl: editedUrl,
        designImageUrl: editedUrl,
        message: "Edited artwork saved successfully",
      });
    } catch (error) {
      log.error({ err: error?.message || error }, "Canvas editor save error");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to save edited artwork",
      });
    }
  });

  router.post("/finalize-product", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    // ── Billing enforcement ──────────────────────────────────────────
    if (billingService) {
      const lifestyleCount = Array.isArray(req.body?.lifestylePrompts) && req.body.lifestylePrompts.filter(Boolean).length > 0
        ? req.body.lifestylePrompts.filter(Boolean).length
        : 3; // default 3 lifestyle images
      const check = billingService.canPerformAction(session.shopDomain, "finalize");
      const creditsNeeded = lifestyleCount;
      const remaining = check.limit - check.current;
      if (!check.allowed || remaining < creditsNeeded) {
        return res.status(403).json({
          error: check.isOnTrial
            ? `Trial credit limit reached (${check.current}/${check.limit}). Need ${creditsNeeded} credits.`
            : `Not enough credits (${remaining} remaining, need ${creditsNeeded}). Upgrade for more.`,
          limitReached: true, isOnTrial: check.isOnTrial || false, usage: check,
        });
      }
    }

    const designId = String(req.body?.designId || "").trim();
    if (!designId) {
      return res.status(400).json({ error: "designId is required" });
    }

    const design = designRepository.findById(designId);
    if (!design || design.shopDomain !== session.shopDomain) {
      return res.status(404).json({ error: "Design not found" });
    }

    // â”€â”€ Idempotency: if already published, return existing product â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (design.status === "published" && design.shopifyProductId) {
      return res.json({
        productId: design.shopifyProductId,
        adminUrl: design.adminUrl,
        lifestyleImages: [],
        transparentArtworkUrl: design.rawArtworkUrl || null,
        provider: { lifestyleImages: "cached", listingCopy: "cached", message: "Product was already published." },
        listingCopy: null,
        alreadyPublished: true,
      });
    }

    const publishImmediately =
      typeof req.body?.publishImmediately === "boolean"
        ? req.body.publishImmediately
        : Boolean(design.publishImmediately);
    const requestedLifestylePrompts = Array.isArray(req.body?.lifestylePrompts)
      ? req.body.lifestylePrompts
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [];

    // Optional pricing — merchant can set price or leave blank
    const price = req.body?.price ? String(req.body.price).trim() : null;
    const compareAtPrice = req.body?.compareAtPrice ? String(req.body.compareAtPrice).trim() : null;

    try {
      log.info({ designId, shop: session.shopDomain, productType: design.productType }, "Finalize starting");
      const settings = getEffectiveSettings(session.shopDomain);
      const hasOpenAi = Boolean(settings?.openAiApiKey && settings.openAiApiKey.length > 5);
      const hasKie = Boolean(settings?.keiAiApiKey && settings.keiAiApiKey.length > 5);
      const hasStability = Boolean(settings?.stabilityApiKey && settings.stabilityApiKey.length > 10);
      log.debug({ hasOpenAi, hasKie, hasStability }, "Finalize API key availability");

      // ── Step 1: Generate product images ─────────────────────────────────
      let lifestyleResult;
      try {
        log.debug({}, "Finalize step 1: generating product images");
        lifestyleResult = await pipelineService.generateLifestyleImages({
          productType: design.productType,
          baseDesignImageUrl: design.previewImageUrl,
          designConcept: design.prompt,
          keiAiApiKey: settings?.keiAiApiKey || "",
          kieEditUrl: settings?.kieEditUrl,
          openAiApiKey: settings?.openAiApiKey || "",
          stabilityApiKey: settings?.stabilityApiKey || "",
          lifestylePrompts: requestedLifestylePrompts,
          maxWaitMs: 30000,
          pollIntervalMs: 2500,
          shopDomain: session.shopDomain,
        });
        log.info({ provider: lifestyleResult.provider, imageCount: lifestyleResult.imageUrls?.length || 0 }, "Finalize step 1 complete");
      } catch (imgErr) {
        log.error({ err: imgErr?.message, stack: imgErr?.stack }, "Finalize step 1 failed");
        // Provide fallback so the rest of finalize can still complete
        const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#e0e0e0"/><text x="50%" y="50%" font-family="sans-serif" font-size="24" fill="#888" text-anchor="middle" dominant-baseline="middle">Image unavailable</text></svg>`;
        lifestyleResult = {
          imageUrls: [`data:image/svg+xml;base64,${Buffer.from(placeholderSvg).toString('base64')}`],
          provider: "fallback-error",
          providerMessage: `Product image generation failed: ${imgErr?.message || "unknown error"}`,
        };
      }

      let lifestyleImages = lifestyleResult.imageUrls || [];

      // ── Step 1c: Persist external URLs to disk ──────────────────────────
      try {
        for (let i = 0; i < lifestyleImages.length; i++) {
          lifestyleImages[i] = await persistImageUrl(lifestyleImages[i], session.shopDomain);
        }
      } catch (persistErr) {
        log.warn({ err: persistErr?.message }, "Image persistence warning");
      }
      // Filter out any URLs that failed to persist or resolve
      lifestyleImages = lifestyleImages.filter(Boolean);

      // ── Step 2: Transparent artwork ─────────────────────────────────────
      let transparentArtworkUrl = design.rawArtworkUrl || null;
      try {
        if (transparentArtworkUrl) {
          assetStorageService.saveAsset({
            designId,
            shopDomain: session.shopDomain,
            type: "artwork-transparent",
            role: "final",
            url: transparentArtworkUrl,
            promptSnapshot: "Raw artwork (generated before product mockup)",
          });
        } else {
          transparentArtworkUrl = await pipelineService.extractArtwork({
            designImageUrl: design.previewImageUrl,
            openAiApiKey: settings?.openAiApiKey || "",
          });
          if (transparentArtworkUrl) {
            assetStorageService.saveAsset({
              designId,
              shopDomain: session.shopDomain,
              type: "artwork-transparent",
              role: "final",
              url: transparentArtworkUrl,
              promptSnapshot: "Isolated artwork with transparent background",
            });
          }
        }
      } catch (artworkErr) {
        log.warn({ err: artworkErr?.message }, "Finalize step 2 extractArtwork error (non-fatal)");
      }

      // ── Step 3: Generate listing copy ───────────────────────────────────
      let listingCopy;
      try {
        log.debug({}, "Finalize step 3: generating listing copy");
        const listingCopyResult = await pipelineService.generateListingCopy({
          prompt: design.prompt,
          productType: design.productType,
          openAiApiKey: settings?.openAiApiKey || "",
        });
        listingCopy = listingCopyResult.copy;
        log.info({ provider: listingCopyResult.provider }, "Finalize step 3 complete");
      } catch (copyErr) {
        log.error({ err: copyErr?.message }, "Finalize step 3 listing copy error (using fallback)");
        listingCopy = {
          title: `${design.productType.toUpperCase()} - ${design.prompt.slice(0, 45)}`,
          descriptionHtml: `<p>${design.prompt}</p>`,
          descriptionText: design.prompt,
          tags: ["ai-generated", "pod", design.productType],
        };
      }

      // ── Step 4: Save asset records ──────────────────────────────────────
      try {
        for (const imageUrl of lifestyleImages) {
          assetStorageService.saveAsset({
            designId,
            shopDomain: session.shopDomain,
            type: "lifestyle",
            role: "final",
            url: imageUrl,
            promptSnapshot: design.artworkPrompt,
          });
        }
      } catch (assetErr) {
        log.warn({ err: assetErr?.message }, "Finalize step 4 asset save error (non-fatal)");
      }

      // ── Step 5: Shopify publish (non-fatal) ─────────────────────────────
      let publishedProduct = null;
      let publishError = null;
      try {
        log.debug({}, "Finalize step 5: publishing to Shopify");
        publishedProduct = await publishService.publish({
          shopDomain: session.shopDomain,
          title: listingCopy.title,
          descriptionHtml: listingCopy.descriptionHtml,
          tags: listingCopy.tags,
          imageUrls: [design.previewImageUrl, ...lifestyleImages],
          publishImmediately,
          price,
          compareAtPrice,
          productType: design.productType,
        });
      } catch (pubErr) {
        log.error({ err: pubErr?.message }, "Finalize step 5 Shopify publish failed (non-fatal)");
        publishError = pubErr?.message || "Shopify publish failed";
      }

      // ── Step 6: Update design status ────────────────────────────────────
      try {
        if (publishedProduct) {
          designRepository.update(designId, {
            status: "published",
            shopifyProductId: publishedProduct.productId,
            adminUrl: publishedProduct.adminUrl,
            updatedAt: Date.now(),
            finalizedAt: Date.now(),
          });

          productRepository.upsertByDesign(designId, {
            designId,
            shopDomain: session.shopDomain,
            productId: publishedProduct.productId,
            adminUrl: publishedProduct.adminUrl,
            publishImmediately,
            updatedAt: Date.now(),
          });

          // Publishing is free — credits are only used for AI generation
        } else {
          designRepository.update(designId, {
            status: "finalized",
            updatedAt: Date.now(),
            finalizedAt: Date.now(),
          });
        }
      } catch (statusErr) {
        log.warn({ err: statusErr?.message }, "Finalize step 6 status update error (non-fatal)");
      }

      const providerMessages = [lifestyleResult.providerMessage];
      if (publishError) {
        providerMessages.push(`Shopify publish skipped: ${publishError}. You can publish later once OAuth is configured.`);
      }

      // Record credit usage — 1 credit per lifestyle image generated
      if (billingService) {
        const creditCount = lifestyleImages.length || 1;
        for (let i = 0; i < creditCount; i++) {
          billingService.recordUsage(session.shopDomain);
        }
      }

      log.info({ imageCount: lifestyleImages.length, published: !!publishedProduct }, "Finalize complete");
      return res.json({
        productId: publishedProduct?.productId || null,
        adminUrl: publishedProduct?.adminUrl || null,
        lifestyleImages,
        transparentArtworkUrl,
        publishError: publishError || null,
        provider: {
          lifestyleImages: lifestyleResult.provider,
          listingCopy: "ok",
          message: providerMessages.filter(Boolean).join(" | "),
        },
        listingCopy: {
          title: listingCopy.title,
          descriptionText: listingCopy.descriptionText,
          tags: listingCopy.tags,
        },
      });
    } catch (error) {
      log.error({ err: error?.message || error, stack: error?.stack }, "Finalize FATAL error");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to finalize product",
      });
    }
  });

  // ── Retry publishing a finalized design to Shopify ──────────────────────
  router.post("/retry-publish", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const designId = String(req.body?.designId || "").trim();
    if (!designId) return res.status(400).json({ error: "designId is required" });

    const design = designRepository.findById(designId);
    if (!design || design.shopDomain !== session.shopDomain) {
      return res.status(404).json({ error: "Design not found" });
    }

    // Already published?
    if (design.status === "published" && design.shopifyProductId) {
      return res.json({
        productId: design.shopifyProductId,
        adminUrl: design.adminUrl,
        alreadyPublished: true,
      });
    }

    const publishImmediately = typeof req.body?.publishImmediately === "boolean"
      ? req.body.publishImmediately
      : Boolean(design.publishImmediately);

    // Gather images — from assets if available, otherwise use previewImageUrl
    const assets = assetStorageService.listDesignAssets(designId);
    const lifestyleUrls = assets
      .filter((a) => a.type === "lifestyle")
      .map((a) => a.url);
    const imageUrls = [design.previewImageUrl, ...lifestyleUrls].filter(Boolean);

    // Build listing copy from design data
    const settings = getEffectiveSettings(session.shopDomain);
    let listingCopy;
    try {
      const result = await pipelineService.generateListingCopy({
        prompt: design.prompt,
        productType: design.productType,
        openAiApiKey: settings?.openAiApiKey || "",
      });
      listingCopy = result.copy;
    } catch {
      listingCopy = {
        title: `${design.productType.toUpperCase()} - ${design.prompt.slice(0, 45)}`,
        descriptionHtml: `<p>${design.prompt}</p>`,
        tags: ["ai-generated", "pod", design.productType],
      };
    }

    // Optional pricing from request
    const retryPrice = req.body?.price ? String(req.body.price).trim() : null;
    const retryCompareAtPrice = req.body?.compareAtPrice ? String(req.body.compareAtPrice).trim() : null;

    try {
      const publishedProduct = await publishService.publish({
        shopDomain: session.shopDomain,
        title: listingCopy.title,
        descriptionHtml: listingCopy.descriptionHtml,
        tags: listingCopy.tags,
        imageUrls,
        publishImmediately,
        price: retryPrice,
        compareAtPrice: retryCompareAtPrice,
        productType: design.productType,
      });

      designRepository.update(designId, {
        status: "published",
        shopifyProductId: publishedProduct.productId,
        adminUrl: publishedProduct.adminUrl,
        updatedAt: Date.now(),
      });

      productRepository.upsertByDesign(designId, {
        designId,
        shopDomain: session.shopDomain,
        productId: publishedProduct.productId,
        adminUrl: publishedProduct.adminUrl,
        publishImmediately,
        updatedAt: Date.now(),
      });

      return res.json({
        productId: publishedProduct.productId,
        adminUrl: publishedProduct.adminUrl,
      });
    } catch (pubErr) {
      log.error({ err: pubErr?.message }, "Retry publish failed");
      return res.json({
        productId: null,
        adminUrl: null,
        publishError: pubErr?.message || "Publish failed",
      });
    }
  });

  router.get("/designs", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    const designs = designRepository.listByShop(session.shopDomain).map((design) => {
      // Validate local preview images still exist on disk (Railway ephemeral FS)
      let previewUrl = design.previewImageUrl || null;
      if (previewUrl && previewUrl.startsWith("/uploads/")) {
        const localPath = path.join(uploadsDir, path.basename(previewUrl));
        if (!fs.existsSync(localPath)) {
          previewUrl = null; // File was lost (redeploy / cleanup)
        }
      }
      return {
        id: design.id,
        prompt: design.prompt,
        productType: design.productType,
        status: design.status,
        previewImageUrl: previewUrl,
        adminUrl: design.adminUrl,
        shopifyProductId: design.shopifyProductId,
        createdAt: design.createdAt,
        updatedAt: design.updatedAt,
      };
    });

    return res.json({ designs });
  });

  router.delete("/designs/:designId", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const design = designRepository.findById(req.params.designId);
    if (!design || design.shopDomain !== session.shopDomain) {
      return res.status(404).json({ error: "Design not found" });
    }

    // Remove associated assets
    assetStorageService.assetRepository.deleteByDesign(design.id);
    designRepository.delete(design.id);

    return res.json({ success: true });
  });

  router.get("/designs/:designId/assets", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
    }

    const design = designRepository.findById(req.params.designId);
    if (!design || design.shopDomain !== session.shopDomain) {
      return res.status(404).json({ error: "Design not found" });
    }

    return res.json({
      designId: design.id,
      assets: assetStorageService.listDesignAssets(design.id),
    });
  });

  return router;
}

module.exports = {
  createPodRouter,
};
