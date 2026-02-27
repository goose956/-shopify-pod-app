const express = require("express");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

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

function createPodRouter({ authService, memberAuthService, memberRepository, analyticsService, designRepository, productRepository, settingsRepository, pipelineService, assetStorageService, publishService, printfulMockupService, config }) {
  const router = express.Router();
  const uploadsDir = config?.storage?.uploadsDir || path.join(__dirname, "..", "..", "data", "uploads");

  /** Download an external http(s) URL to local uploads dir and return a /uploads/ path. */
  async function persistImageUrl(imageUrl) {
    if (!imageUrl || typeof imageUrl !== "string") return imageUrl;
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) return imageUrl;
    try {
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const resp = await fetch(imageUrl);
      if (!resp.ok) return imageUrl;
      const ct = resp.headers.get("content-type") || "image/png";
      const ext = ct.includes("webp") ? "webp" : ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "png";
      const filename = `${randomUUID()}.${ext}`;
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, Buffer.from(await resp.arrayBuffer()));
      console.log(`[Finalize] Persisted external image to ${filename}`);
      return `/uploads/${filename}`;
    } catch (err) {
      console.error("[Finalize] Failed to persist image URL:", err?.message);
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
      return {
        ...shopifySession,
        authType: "shopify",
      };
    }

    const memberSession = await memberAuthService.validateRequest(req);
    if (memberSession?.shopDomain) {
      return {
        ...memberSession,
        subject: memberSession.memberId,
        authType: "member",
      };
    }

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

  // ── Debug: check OAuth token status for current session ─────────────────
  router.get("/debug-auth", async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.shopDomain) {
      return res.status(401).json({ error: "No session" });
    }

    const shopSettings = settingsRepository.findByShop(session.shopDomain);
    const allSettings = settingsRepository.store?.read?.()?.settings || [];
    const shopDomains = allSettings
      .filter(s => !s.shopDomain?.startsWith("_nonce:"))
      .map(s => ({
        domain: s.shopDomain,
        hasToken: Boolean(s.shopifyAccessToken),
        tokenPrefix: s.shopifyAccessToken ? s.shopifyAccessToken.slice(0, 8) + "..." : "none",
        installedAt: s.installedAt,
      }));

    res.json({
      sessionShopDomain: session.shopDomain,
      authType: session.authType,
      tokenFound: Boolean(shopSettings?.shopifyAccessToken),
      tokenPrefix: shopSettings?.shopifyAccessToken ? shopSettings.shopifyAccessToken.slice(0, 8) + "..." : "none",
      allShops: shopDomains,
    });
  });

  // ── Manual token set (requires SETUP_SECRET) ──────────────────────────────
  router.post("/set-shopify-token", async (req, res) => {
    const session = await resolveSession(req);
    if (!session?.shopDomain) {
      return res.status(401).json({ error: "No session" });
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

    // Verify
    const saved = settingsRepository.findByShop(targetShop);
    res.json({
      ok: true,
      shop: targetShop,
      tokenSaved: Boolean(saved?.shopifyAccessToken),
      tokenPrefix: saved?.shopifyAccessToken ? saved.shopifyAccessToken.slice(0, 8) + "..." : "none",
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

    const allMembers = memberRepository.list();
    const allDesigns = designRepository.listByShop(shopSession.shopDomain);
    const published = allDesigns.filter((item) => item.status === "published").length;
    const designCountsByMember = designRepository.countByMember(shopSession.shopDomain);

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
    return res.json({
      imageProviderDefault: "openai",
      keiAiApiKey: maskKey(settings.keiAiApiKey),
      openAiApiKey: maskKey(settings.openAiApiKey),
      kieGenerateUrl: settings.kieGenerateUrl || "https://api.kie.ai/api/v1/gpt4o-image/generate",
      kieEditUrl: settings.kieEditUrl || "https://api.kie.ai/api/v1/gpt4o-image/generate",
      printfulApiKey: maskKey(settings.printfulApiKey),
      // Tell the frontend which keys are configured (without exposing them)
      hasOpenAiKey: Boolean(settings.openAiApiKey),
      hasKeiAiKey: Boolean(settings.keiAiApiKey),
      hasPrintfulKey: Boolean(settings.printfulApiKey),
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

    const prompt = sanitize(req.body?.prompt, 5000);
    const productType = sanitize(req.body?.productType || "mug", 50).toLowerCase();
    const imageShape = sanitize(req.body?.imageShape || "square", 20).toLowerCase();
    const publishImmediately = Boolean(req.body?.publishImmediately);

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    try {
      const settings = getEffectiveSettings(session.shopDomain);

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

      return res.json({
        designId: savedDesign.id,
        rawArtworkUrl,
        provider: {
          designImage: designResult.provider,
          message: designResult.providerMessage,
        },
      });
    } catch (error) {
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
      console.error("[Catalog] Error:", error?.message);
      return res.status(500).json({ error: "Failed to fetch product catalog" });
    }
  });

  // Generate product mockup from approved artwork
  router.post("/generate-mockup", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
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

    try {
      const settings = getEffectiveSettings(session.shopDomain);
      const imageShape = String(req.body?.imageShape || "square").trim().toLowerCase();
      const printfulProductId = req.body?.printfulProductId || null;

      // Try Printful first (free, professional mockups)
      if (printfulMockupService && settings?.printfulApiKey) {
        console.log(`[Mockup] Trying Printful for ${design.productType}${printfulProductId ? ` (Printful #${printfulProductId})` : ""}...`);
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
        console.log(`[Mockup] Printful unavailable: ${printfulResult.providerMessage}. Falling back to AI.`);
      }

      // Fallback: AI-generated mockup
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

  router.post("/finalize-product", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) {
      return;
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

    try {
      console.log(`[Finalize] Starting for designId=${designId}, shop=${session.shopDomain}, productType=${design.productType}`);
      const settings = getEffectiveSettings(session.shopDomain);
      const hasOpenAi = Boolean(settings?.openAiApiKey && settings.openAiApiKey.length > 5);
      const hasKie = Boolean(settings?.keiAiApiKey && settings.keiAiApiKey.length > 5);
      const hasStability = Boolean(settings?.stabilityApiKey && settings.stabilityApiKey.length > 10);
      console.log(`[Finalize] API keys — OpenAI: ${hasOpenAi}, KIE: ${hasKie}, Stability: ${hasStability}`);

      // ── Step 1: Generate product images ─────────────────────────────────
      let lifestyleResult;
      try {
        console.log("[Finalize] Step 1: Generating product images...");
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
        });
        console.log(`[Finalize] Step 1 result: provider=${lifestyleResult.provider}, images=${lifestyleResult.imageUrls?.length || 0}`);
      } catch (imgErr) {
        console.error("[Finalize] Step 1 failed:", imgErr?.message, imgErr?.stack);
        // Provide fallback so the rest of finalize can still complete
        lifestyleResult = {
          imageUrls: [`https://via.placeholder.com/1024?text=${encodeURIComponent(design.productType + " product image")}`],
          provider: "fallback-error",
          providerMessage: `Product image generation failed: ${imgErr?.message || "unknown error"}`,
        };
      }

      // ── Step 1b: OpenAI fallback if primary provider failed ─────────────
      if (lifestyleResult.provider !== "kie" && lifestyleResult.provider !== "openai") {
        try {
          console.log("[Finalize] Step 1b: Trying OpenAI fallback for product images...");
          const scenePrompts = requestedLifestylePrompts.length
            ? requestedLifestylePrompts
            : [
                `Place this exact ${design.productType} product on a kitchen table in a bright room with natural daylight. Keep the product design exactly as shown in the reference image.`,
                `Show this exact ${design.productType} product in a clean, minimal flat-lay arrangement on a light surface. Keep the product design exactly as shown in the reference image.`,
                `Show a person holding this exact ${design.productType} product in a lifestyle setting. Keep the product design exactly as shown in the reference image.`,
              ];

          const openAiLifestyleImages = [];
          for (const scenePrompt of scenePrompts) {
            let imageUrl = null;
            try {
              imageUrl = await pipelineService.generateOpenAiImageEdit({
                prompt: scenePrompt,
                referenceImageUrl: design.previewImageUrl,
                openAiApiKey: settings?.openAiApiKey || "",
              });
            } catch { /* ignore */ }
            if (!imageUrl) {
              try {
                imageUrl = await pipelineService.generateOpenAiImage({
                  prompt: scenePrompt,
                  openAiApiKey: settings?.openAiApiKey || "",
                });
              } catch { /* ignore */ }
            }
            if (imageUrl) {
              openAiLifestyleImages.push(imageUrl);
            }
          }

          if (openAiLifestyleImages.length === scenePrompts.length) {
            lifestyleResult = {
              imageUrls: openAiLifestyleImages,
              provider: "openai-image-fallback",
              providerMessage: `KIE unavailable. Used OpenAI image generation for product scenes. Previous message: ${lifestyleResult.providerMessage}`,
            };
          }
          console.log(`[Finalize] Step 1b result: provider=${lifestyleResult.provider}, images=${lifestyleResult.imageUrls?.length || 0}`);
        } catch (fallbackErr) {
          console.error("[Finalize] Step 1b fallback failed:", fallbackErr?.message);
        }
      }
      const lifestyleImages = lifestyleResult.imageUrls || [];

      // ── Step 1c: Persist external URLs to disk ──────────────────────────
      try {
        for (let i = 0; i < lifestyleImages.length; i++) {
          lifestyleImages[i] = await persistImageUrl(lifestyleImages[i]);
        }
      } catch (persistErr) {
        console.error("[Finalize] Image persistence warning:", persistErr?.message);
      }

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
        console.error("[Finalize] Step 2 extractArtwork error (non-fatal):", artworkErr?.message);
      }

      // ── Step 3: Generate listing copy ───────────────────────────────────
      let listingCopy;
      try {
        console.log("[Finalize] Step 3: Generating listing copy...");
        const listingCopyResult = await pipelineService.generateListingCopy({
          prompt: design.prompt,
          productType: design.productType,
          openAiApiKey: settings?.openAiApiKey || "",
        });
        listingCopy = listingCopyResult.copy;
        console.log(`[Finalize] Step 3 result: provider=${listingCopyResult.provider}`);
      } catch (copyErr) {
        console.error("[Finalize] Step 3 listing copy error (using fallback):", copyErr?.message);
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
        console.error("[Finalize] Step 4 asset save error (non-fatal):", assetErr?.message);
      }

      // ── Step 5: Shopify publish (non-fatal) ─────────────────────────────
      let publishedProduct = null;
      let publishError = null;
      try {
        console.log("[Finalize] Step 5: Publishing to Shopify...");
        publishedProduct = await publishService.publish({
          shopDomain: session.shopDomain,
          title: listingCopy.title,
          descriptionHtml: listingCopy.descriptionHtml,
          tags: listingCopy.tags,
          imageUrls: [design.previewImageUrl, ...lifestyleImages],
          publishImmediately,
        });
      } catch (pubErr) {
        console.error("[Finalize] Step 5 Shopify publish failed (non-fatal):", pubErr?.message);
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
        } else {
          designRepository.update(designId, {
            status: "finalized",
            updatedAt: Date.now(),
            finalizedAt: Date.now(),
          });
        }
      } catch (statusErr) {
        console.error("[Finalize] Step 6 status update error (non-fatal):", statusErr?.message);
      }

      const providerMessages = [lifestyleResult.providerMessage];
      if (publishError) {
        providerMessages.push(`Shopify publish skipped: ${publishError}. You can publish later once OAuth is configured.`);
      }

      console.log(`[Finalize] Complete — images=${lifestyleImages.length}, published=${!!publishedProduct}`);
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
      console.error("[Finalize] FATAL Error:", error?.message || error, error?.stack);
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

    try {
      const publishedProduct = await publishService.publish({
        shopDomain: session.shopDomain,
        title: listingCopy.title,
        descriptionHtml: listingCopy.descriptionHtml,
        tags: listingCopy.tags,
        imageUrls,
        publishImmediately,
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
      console.error("[RetryPublish] Failed:", pubErr?.message);
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

    const designs = designRepository.listByShop(session.shopDomain).map((design) => ({
      id: design.id,
      prompt: design.prompt,
      productType: design.productType,
      status: design.status,
      previewImageUrl: design.previewImageUrl,
      adminUrl: design.adminUrl,
      shopifyProductId: design.shopifyProductId,
      createdAt: design.createdAt,
      updatedAt: design.updatedAt,
    }));

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
