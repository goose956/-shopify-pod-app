const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

function saveBase64ToDisk(uploadsDir, base64Data, mimeType = "image/png") {
  try {
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const ext = mimeType.includes("webp") ? "webp" : mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
    const filename = `${randomUUID()}.${ext}`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
    console.log(`[Image] Saved ${(Buffer.byteLength(base64Data, "base64") / 1024).toFixed(0)}KB image to ${filename}`);
    return `/uploads/${filename}`;
  } catch (err) {
    console.error("[Image] Failed to save base64 to disk:", err?.message);
    return null;
  }
}

class PodPipelineService {
  constructor(uploadsDir) {
    this.uploadsDir = uploadsDir || path.join(__dirname, "..", "..", "data", "uploads");
  }

  _trackCost({ provider, model, operation }) {
    if (this.analyticsService?.trackApiCall) {
      this.analyticsService.trackApiCall({ provider, model, operation });
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  deriveKieRecordInfoUrl(generateUrl) {
    const clean = String(generateUrl || "").trim();
    if (!clean) {
      return "";
    }

    if (clean.includes("/generate")) {
      return clean.replace(/\/generate(?:\?.*)?$/, "/record-info");
    }

    if (clean.endsWith("/")) {
      return `${clean}record-info`;
    }

    return `${clean}/record-info`;
  }

  pickKieResultImage(statusPayload) {
    const response = statusPayload?.response || statusPayload?.data?.response;
    return (
      response?.resultImageUrl ||
      response?.resultUrls?.[0] ||
      response?.result_urls?.[0] ||
      response?.images?.[0]?.url ||
      statusPayload?.resultImageUrl ||
      statusPayload?.resultUrls?.[0] ||
      statusPayload?.result_urls?.[0] ||
      null
    );
  }

  pickKieTaskId(createPayload) {
    return (
      createPayload?.data?.taskId ||
      createPayload?.data?.task_id ||
      createPayload?.taskId ||
      createPayload?.task_id ||
      null
    );
  }

  pickKieSuccessFlag(statusData) {
    const raw =
      statusData?.successFlag ??
      statusData?.success_flag ??
      statusData?.status ??
      null;

    if (raw === null || raw === undefined) {
      return null;
    }

    if (typeof raw === "string") {
      const normalized = raw.trim().toUpperCase();
      if (normalized === "SUCCESS") {
        return 1;
      }
      if (normalized === "GENERATING" || normalized === "PENDING" || normalized === "PROCESSING") {
        return 0;
      }
      if (normalized === "CREATE_TASK_FAILED") {
        return 2;
      }
      if (normalized === "GENERATE_FAILED" || normalized === "FAILED" || normalized === "ERROR") {
        return 3;
      }
    }

    const numeric = Number(raw);
    return Number.isNaN(numeric) ? null : numeric;
  }

  pickKieErrorMessage(payload) {
    return (
      payload?.errorMessage ||
      payload?.error_message ||
      payload?.msg ||
      "KIE reported task failure"
    );
  }

  // Map shape name to OpenAI size string
  getOpenAiSize(imageShape) {
    const sizeMap = {
      square: "1024x1024",
      portrait: "1024x1536",
      landscape: "1536x1024",
      tall_portrait: "1024x1536",
      wide_landscape: "1536x1024",
    };
    return sizeMap[imageShape] || "1024x1024";
  }

  // Map shape name to KIE aspect ratio string
  getKieAspectRatio(imageShape) {
    const ratioMap = {
      square: "1:1",
      portrait: "3:4",
      landscape: "4:3",
      tall_portrait: "2:3",
      wide_landscape: "3:2",
    };
    return ratioMap[imageShape] || "1:1";
  }

  async requestKieImage({ prompt, inputImageUrl, keiAiApiKey, generateUrl, imageShape, maxWaitMs, pollIntervalMs }) {
    const targetUrl = String(generateUrl || "").trim() || "https://api.kie.ai/api/v1/gpt4o-image/generate";
    const recordInfoUrl = this.deriveKieRecordInfoUrl(targetUrl);
    const isFlux = targetUrl.includes("/flux/kontext/");
    const is4o = targetUrl.includes("/gpt4o-image/");

    const kieRatio = this.getKieAspectRatio(imageShape);

    const requestBody = isFlux
      ? {
          prompt,
          aspectRatio: kieRatio,
          model: "flux-kontext-pro",
          ...(inputImageUrl ? { inputImage: inputImageUrl } : {}),
        }
      : is4o
        ? {
            prompt,
            size: kieRatio,
            nVariants: 1,
            isEnhance: true,
            enableFallback: true,
            ...(inputImageUrl ? { filesUrl: [inputImageUrl] } : {}),
          }
        : {
            prompt,
            size: kieRatio,
            nVariants: 1,
            ...(inputImageUrl ? { filesUrl: [inputImageUrl] } : {}),
          };

    const createResponse = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${keiAiApiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!createResponse.ok) {
      throw new Error(`KIE image generation failed (${createResponse.status})`);
    }

    const createPayload = await createResponse.json();
    if (createPayload?.code && Number(createPayload.code) !== 200) {
      throw new Error(this.pickKieErrorMessage(createPayload));
    }

    const taskId = this.pickKieTaskId(createPayload);
    if (!taskId) {
      const directUrl = this.pickKieResultImage(createPayload?.data || createPayload);
      if (directUrl) {
        this._trackCost({ provider: "kie", model: "image", operation: "generate" });
        return directUrl;
      }
      throw new Error(`KIE returned no taskId. Message: ${this.pickKieErrorMessage(createPayload)}`);
    }

    if (!recordInfoUrl) {
      throw new Error("KIE record-info endpoint could not be derived");
    }

    const sleepMs = Number(pollIntervalMs) > 0 ? Number(pollIntervalMs) : is4o ? 2500 : 2000;
    const waitMs = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : is4o ? 60000 : 45000;
    const maxAttempts = Math.max(1, Math.floor(waitMs / sleepMs));
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const statusResponse = await fetch(`${recordInfoUrl}?taskId=${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${keiAiApiKey}`,
        },
      });

      if (!statusResponse.ok) {
        throw new Error(`KIE status check failed (${statusResponse.status})`);
      }

      const statusPayload = await statusResponse.json();
      if (statusPayload?.code && Number(statusPayload.code) !== 200) {
        throw new Error(this.pickKieErrorMessage(statusPayload));
      }

      const data = statusPayload?.data || statusPayload;
      const successFlag = this.pickKieSuccessFlag(data);
      const imageUrl = this.pickKieResultImage(data);

      if ((successFlag === 1 || successFlag === 200) && imageUrl) {
        this._trackCost({ provider: "kie", model: "image", operation: "generate" });
        return imageUrl;
      }

      if (successFlag === 2 || successFlag === 3) {
        throw new Error(this.pickKieErrorMessage(data));
      }

      if (imageUrl) {
        return imageUrl;
      }

      await this.sleep(sleepMs);
    }

    throw new Error(`KIE generation timed out after ${waitMs}ms while waiting for result (taskId=${taskId})`);
  }

  isUsableApiKey(value) {
    const key = String(value || "").trim();
    if (!key) {
      return false;
    }

    if (key.startsWith("kei_test_") || key.startsWith("openai_test_")) {
      return false;
    }

    return true;
  }

  async buildArtworkPrompt({ prompt, productType, amendment = "" }) {
    const amendmentText = amendment.trim() ? ` with revision: ${amendment.trim()}` : "";
    return `Create a clean, isolated artwork design for print-on-demand. The design concept: ${prompt}${amendmentText}. Render the artwork on a SOLID WHITE background. The background must be pure white (#FFFFFF) with absolutely no transparency. No product, no mockup, no surface — just the standalone graphic/illustration on a flat white background, ready to be printed.`;
  }

  buildMockupPrompt({ productType, designConcept }) {
    return [
      `Create a clean, photorealistic ${productType} product mockup.`,
      `The provided reference image is the EXACT artwork to be printed on the ${productType}.`,
      `CRITICAL RULES:`,
      `- Reproduce the reference artwork EXACTLY as-is on the product — same colors, same composition, same details.`,
      `- Do NOT add any drop shadows, glows, outlines, or effects to the artwork.`,
      `- Do NOT modify, reinterpret, or "improve" the artwork in any way.`,
      `- Use a clean, plain white or very light neutral background.`,
      `- Soft, even studio lighting with no harsh shadows on the product.`,
      `- The ${productType} should be shown straight-on, centered, with the artwork clearly visible.`,
      `- No extra props, decorations, or text outside the artwork itself.`,
    ].join("\n");
  }

  async analyzeProductImage({ imageBase64, openAiApiKey }) {
    if (!this.isUsableApiKey(openAiApiKey)) {
      throw new Error("OpenAI API key is missing or invalid.");
    }

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 400,
          messages: [
            {
              role: "system",
              content: "You are a product design analyst. When given an image of a product (t-shirt, mug, poster, etc), describe ONLY the artwork/design on the product in detail. Focus on: the subject matter, art style, colour palette, mood, and any text. Do NOT describe the product itself (the blank t-shirt, mug shape, etc) — only the printed design. Write a concise, vivid description that could be used as a prompt to recreate a similar design. Keep it under 100 words.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Describe the artwork/design on this product so I can recreate something similar:",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}`,
                    detail: "high",
                  },
                },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || `OpenAI vision request failed (${response.status})`);
      }

      this._trackCost({ provider: "openai", model: "gpt-4o-mini", operation: "analyze-image" });

      const payload = await response.json();
      const description = payload?.choices?.[0]?.message?.content?.trim() || "";
      if (!description) {
        throw new Error("OpenAI returned an empty description.");
      }

      return { description };
    } catch (err) {
      console.error("[AnalyzeImage] exception:", err?.message);
      throw err;
    }
  }

  async generateDesignImage({ artworkPrompt, openAiApiKey, keiAiApiKey, kieGenerateUrl, referenceImageUrl, imageShape, maxWaitMs, pollIntervalMs }) {
    if (this.isUsableApiKey(openAiApiKey)) {
      let openAiImageUrl = null;
      let usedReferenceImage = false;

      if (referenceImageUrl) {
        openAiImageUrl = await this.generateOpenAiImageEdit({
          prompt: artworkPrompt,
          referenceImageUrl,
          openAiApiKey,
          imageShape,
        });
        usedReferenceImage = Boolean(openAiImageUrl);
      }

      if (!openAiImageUrl) {
        const openAiPrompt = referenceImageUrl
          ? `${artworkPrompt}\n\nKeep the updated design very close to the previous version and apply only the requested change.`
          : artworkPrompt;

        openAiImageUrl = await this.generateOpenAiImage({
          prompt: openAiPrompt,
          openAiApiKey,
          imageShape,
        });
      }

      if (openAiImageUrl) {
        const providerMessage = usedReferenceImage
          ? "Live OpenAI image edit used. Reference image provided: true."
          : `Live OpenAI image generation used${referenceImageUrl ? " without reference image" : ""}. Reference image requested: ${Boolean(referenceImageUrl)}.`;

        return {
          imageUrl: openAiImageUrl,
          provider: "openai",
          providerMessage,
        };
      }
    }

    if (!this.isUsableApiKey(keiAiApiKey)) {
      return {
        imageUrl: `https://via.placeholder.com/1024?text=${encodeURIComponent(artworkPrompt.slice(0, 48))}`,
        provider: "fallback-no-key",
        providerMessage: "OpenAI image generation failed or key missing, and KEI API key is missing or invalid format.",
      };
    }

    try {
      const imageUrl = await this.requestKieImage({
        prompt: artworkPrompt,
        inputImageUrl: referenceImageUrl,
        keiAiApiKey,
        generateUrl: kieGenerateUrl,
        imageShape,
        maxWaitMs,
        pollIntervalMs,
      });

      return {
        imageUrl,
        provider: "kie",
        providerMessage: `Live KEI image generation used. Reference image provided: ${Boolean(referenceImageUrl)}.`,
      };
    } catch (error) {
      return {
        imageUrl: `https://via.placeholder.com/1024?text=${encodeURIComponent(artworkPrompt.slice(0, 48))}`,
        provider: "fallback-error",
        providerMessage: `${error instanceof Error ? error.message : "KEI request failed."} Reference image provided: ${Boolean(referenceImageUrl)}.`,
      };
    }
  }

  async generateOpenAiImage({ prompt, openAiApiKey, imageShape }) {
    if (!this.isUsableApiKey(openAiApiKey)) {
      return null;
    }

    const openAiSize = this.getOpenAiSize(imageShape);

    const attemptGeneration = async (model, extraBody = {}) => {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({ model, prompt, size: openAiSize, ...extraBody }),
      });
      return response;
    };

    try {
      // Try gpt-image-1 first; fall back to dall-e-3 if that model isn't on this tier
      let response = await attemptGeneration("gpt-image-1");
      let usedModel = "gpt-image-1";

      if (!response.ok) {
        const status = response.status;
        // 400/403/404 typically means the model isn't available on this account tier
        if (status === 400 || status === 403 || status === 404) {
          response = await attemptGeneration("dall-e-3", { response_format: "url" });
          usedModel = "dall-e-3";
        }
      }

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const msg = errBody?.error?.message || `OpenAI image generation failed (${response.status})`;
        console.error("[OpenAI] generateOpenAiImage error:", msg);
        return null;
      }

      this._trackCost({ provider: "openai", model: usedModel, operation: "generate" });

      const payload = await response.json();
      const url = payload?.data?.[0]?.url;
      if (url) {
        return url;
      }

      // gpt-image-1 returns b64_json — save to disk and return a local URL
      const b64 = payload?.data?.[0]?.b64_json;
      if (b64) {
        const localUrl = saveBase64ToDisk(this.uploadsDir, b64, "image/png");
        if (localUrl) return localUrl;
        // Fallback to data URI if disk save fails
        return `data:image/png;base64,${b64}`;
      }

      return null;
    } catch (err) {
      console.error("[OpenAI] generateOpenAiImage exception:", err?.message);
      return null;
    }
  }

  async generateOpenAiImageEdit({ prompt, referenceImageUrl, openAiApiKey, imageShape }) {
    if (!this.isUsableApiKey(openAiApiKey) || !String(referenceImageUrl || "").trim()) {
      return null;
    }

    try {
      let imageBlob;
      let filename;

      if (String(referenceImageUrl).startsWith("data:")) {
        // Convert data: URI to a Blob directly
        const match = referenceImageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) {
          console.warn("[OpenAI] generateOpenAiImageEdit: invalid data-URI format");
          return null;
        }
        const mimeType = match[1];
        const base64Data = match[2];
        const buffer = Buffer.from(base64Data, "base64");
        imageBlob = new Blob([buffer], { type: mimeType });
        filename = `reference.${mimeType.includes("jpeg") ? "jpg" : "png"}`;
      } else if (String(referenceImageUrl).startsWith("/uploads/")) {
        // Read from local uploads directory
        const localPath = path.join(UPLOADS_DIR, path.basename(referenceImageUrl));
        if (fs.existsSync(localPath)) {
          const buffer = fs.readFileSync(localPath);
          const ext = path.extname(localPath).toLowerCase();
          const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
          imageBlob = new Blob([buffer], { type: mimeType });
          filename = `reference${ext}`;
        } else {
          console.warn("[OpenAI] generateOpenAiImageEdit: local file not found:", localPath);
          return null;
        }
      } else {
        const sourceResponse = await fetch(referenceImageUrl);
        if (!sourceResponse.ok) {
          return null;
        }
        const contentType = sourceResponse.headers.get("content-type") || "image/png";
        imageBlob = await sourceResponse.blob();
        filename = `reference.${contentType.includes("jpeg") ? "jpg" : "png"}`;
      }

      const openAiSize = this.getOpenAiSize(imageShape);

      const buildForm = (model) => {
        const form = new FormData();
        form.append("model", model);
        form.append("prompt", prompt);
        form.append("size", openAiSize);
        form.append("image", imageBlob, filename);
        return form;
      };

      const sendEdit = async (model) => {
        return fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { Authorization: `Bearer ${openAiApiKey}` },
          body: buildForm(model),
        });
      };

      // Try gpt-image-1; fall back to dall-e-2 (edits not supported by dall-e-3)
      let response = await sendEdit("gpt-image-1");
      let usedModel = "gpt-image-1";

      if (!response.ok) {
        const status = response.status;
        if (status === 400 || status === 403 || status === 404) {
          response = await sendEdit("dall-e-2");
          usedModel = "dall-e-2";
        }
      }

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        console.error("[OpenAI] generateOpenAiImageEdit error:", errBody?.error?.message || response.status);
        return null;
      }

      this._trackCost({ provider: "openai", model: usedModel, operation: "edit" });

      const payload = await response.json();
      const url = payload?.data?.[0]?.url;
      if (url) {
        return url;
      }

      const b64Edit = payload?.data?.[0]?.b64_json;
      if (b64Edit) {
        const localUrl = saveBase64ToDisk(this.uploadsDir, b64Edit, "image/png");
        if (localUrl) return localUrl;
        return `data:image/png;base64,${b64Edit}`;
      }

      return null;
    } catch (err) {
      console.error("[OpenAI] generateOpenAiImageEdit exception:", err?.message);
      return null;
    }
  }

  async generateLifestyleImages({ productType, baseDesignImageUrl, designConcept, keiAiApiKey, kieEditUrl, openAiApiKey, lifestylePrompts, maxWaitMs, pollIntervalMs }) {
    // Prompts describe only the SCENE — the actual design image is sent as a
    // reference image to the edit API so the product stays visually consistent.
    const defaultPrompts = [
      `Place this exact ${productType} product on a kitchen table in a bright room with natural daylight. Keep the product design exactly as shown in the reference image.`,
      `Show this exact ${productType} product in a clean, minimal flat-lay arrangement on a light surface. Keep the product design exactly as shown in the reference image.`,
      `Show a person holding this exact ${productType} product in a lifestyle setting. Keep the product design exactly as shown in the reference image.`,
    ];

    const hasReferenceImage = Boolean(baseDesignImageUrl);
    console.log(`[Lifestyle] Starting generation: productType=${productType}, hasReferenceImage=${hasReferenceImage}, referenceIsDataUri=${String(baseDesignImageUrl || "").startsWith("data:")}`);

    const prompts = Array.isArray(lifestylePrompts)
      ? lifestylePrompts.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    const promptsToUse = prompts.length > 0 ? prompts : defaultPrompts;

    if (this.isUsableApiKey(openAiApiKey)) {
      const openAiResults = [];
      let usedReferenceImageCount = 0;
      for (const prompt of promptsToUse) {
        let imageUrl = null;
        if (baseDesignImageUrl) {
          console.log(`[Lifestyle] Attempting image edit with reference image for prompt: ${prompt.slice(0, 60)}...`);
          imageUrl = await this.generateOpenAiImageEdit({
            prompt,
            referenceImageUrl: baseDesignImageUrl,
            openAiApiKey,
          });
          if (imageUrl) {
            console.log(`[Lifestyle] Image edit succeeded — reference design used.`);
            usedReferenceImageCount += 1;
          } else {
            console.warn(`[Lifestyle] Image edit returned null — falling back to generation without reference.`);
          }
        }

        if (!imageUrl) {
          imageUrl = await this.generateOpenAiImage({
            prompt,
            openAiApiKey,
          });
        }

        if (imageUrl) {
          openAiResults.push(imageUrl);
        }
      }

      if (openAiResults.length === promptsToUse.length) {
        let providerMessage = "Live OpenAI lifestyle generation used.";
        if (usedReferenceImageCount === promptsToUse.length) {
          providerMessage = "Live OpenAI lifestyle image edits used with reference design image for all results.";
        } else if (usedReferenceImageCount > 0) {
          providerMessage = `Live OpenAI lifestyle generation used. Reference design image applied to ${usedReferenceImageCount}/${promptsToUse.length} results.`;
        } else if (baseDesignImageUrl) {
          providerMessage = "Live OpenAI lifestyle generation used without reference design image (edit API unavailable for this request).";
        }

        return {
          imageUrls: openAiResults,
          provider: "openai",
          providerMessage,
        };
      }
    }

    if (!this.isUsableApiKey(keiAiApiKey)) {
      const encodedType = encodeURIComponent(productType);
      return {
        imageUrls: promptsToUse.map((prompt) => `https://via.placeholder.com/1024?text=${encodeURIComponent(prompt.slice(0, 60))}`),
        provider: "fallback-no-key",
        providerMessage: "KEI API key is missing or invalid format.",
      };
    }

    const results = [];
    for (const prompt of promptsToUse) {
      try {
        const imageUrl = await this.requestKieImage({
          prompt,
          inputImageUrl: baseDesignImageUrl,
          keiAiApiKey,
          generateUrl: kieEditUrl,
          maxWaitMs,
          pollIntervalMs,
        });
        results.push(imageUrl);
      } catch {
        const encodedPrompt = encodeURIComponent(prompt.slice(0, 45));
        results.push(`https://via.placeholder.com/1024?text=${encodedPrompt}`);
      }
    }

    const hadFallback = results.some((url) => url.includes("via.placeholder.com"));
    return {
      imageUrls: results,
      provider: hadFallback ? "mixed-fallback" : "kie",
      providerMessage: hadFallback
        ? "Some lifestyle images fell back due to provider errors."
        : "Live KEI lifestyle generation used.",
    };
  }

  async generateListingCopy({ prompt, productType, openAiApiKey }) {
    if (!this.isUsableApiKey(openAiApiKey)) {
      return {
        copy: {
          title: `${productType.toUpperCase()} - ${prompt.slice(0, 45)}`,
          descriptionHtml: `<p>${prompt}</p><p>Professionally generated POD design and lifestyle visuals.</p>`,
          descriptionText: `${prompt}. Professionally generated POD design and lifestyle visuals.`,
          tags: ["ai-generated", "pod", productType],
        },
        provider: "fallback-no-key",
        providerMessage: "OpenAI API key is missing or invalid format.",
      };
    }

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.7,
          messages: [
            {
              role: "system",
              content:
                "You generate ecommerce listing copy for Shopify POD products. Return strict JSON with title, descriptionText, and tags (array of short lowercase strings).",
            },
            {
              role: "user",
              content: `Create listing copy for productType=${productType} with concept: ${prompt}`,
            },
          ],
          response_format: {
            type: "json_object",
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI copy generation failed (${response.status})`);
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(content);

      const title = String(parsed.title || `${productType.toUpperCase()} - ${prompt.slice(0, 45)}`).trim();
      const descriptionText = String(
        parsed.descriptionText || `${prompt}. Professionally generated POD design and lifestyle visuals.`
      ).trim();
      const tags = Array.isArray(parsed.tags) ? parsed.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];

      return {
        copy: {
          title,
          descriptionHtml: `<p>${descriptionText}</p>`,
          descriptionText,
          tags: tags.length > 0 ? tags : ["ai-generated", "pod", productType],
        },
        provider: "openai",
        providerMessage: "Live OpenAI copy generation used.",
      };
    } catch (error) {
      return {
        copy: {
          title: `${productType.toUpperCase()} - ${prompt.slice(0, 45)}`,
          descriptionHtml: `<p>${prompt}</p><p>Professionally generated POD design and lifestyle visuals.</p>`,
          descriptionText: `${prompt}. Professionally generated POD design and lifestyle visuals.`,
          tags: ["ai-generated", "pod", productType],
        },
        provider: "fallback-error",
        providerMessage: error instanceof Error ? error.message : "OpenAI request failed.",
      };
    }
  }

  async extractArtwork({ designImageUrl, openAiApiKey }) {
    if (!this.isUsableApiKey(openAiApiKey) || !String(designImageUrl || "").trim()) {
      return null;
    }

    try {
      const prompt = "Extract only the artwork/design from this product image. Remove ALL background completely. Output ONLY the artwork element (logo, illustration, graphic) on a fully transparent background. No product, no surface, no shadows — just the isolated artwork as a clean transparent PNG.";

      // Use the image edit API with transparency request
      let imageBlob;
      let filename;

      if (String(designImageUrl).startsWith("data:")) {
        const match = designImageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) return null;
        const buffer = Buffer.from(match[2], "base64");
        imageBlob = new Blob([buffer], { type: match[1] });
        filename = "reference.png";
      } else {
        const srcResp = await fetch(designImageUrl);
        if (!srcResp.ok) return null;
        imageBlob = await srcResp.blob();
        filename = "reference.png";
      }

      const buildForm = (model) => {
        const form = new FormData();
        form.append("model", model);
        form.append("prompt", prompt);
        form.append("size", "1024x1024");
        form.append("image", imageBlob, filename);
        if (model === "gpt-image-1") {
          form.append("background", "transparent");
        }
        return form;
      };

      let response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${openAiApiKey}` },
        body: buildForm("gpt-image-1"),
      });
      let usedModel = "gpt-image-1";

      if (!response.ok) {
        const status = response.status;
        if (status === 400 || status === 403 || status === 404) {
          response = await fetch("https://api.openai.com/v1/images/edits", {
            method: "POST",
            headers: { Authorization: `Bearer ${openAiApiKey}` },
            body: buildForm("dall-e-2"),
          });
          usedModel = "dall-e-2";
        }
      }

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        console.error("[ExtractArtwork] error:", errBody?.error?.message || response.status);
        return null;
      }

      this._trackCost({ provider: "openai", model: usedModel, operation: "extract-artwork" });

      const payload = await response.json();
      const url = payload?.data?.[0]?.url;
      if (url) return url;

      const b64Extract = payload?.data?.[0]?.b64_json;
      if (b64Extract) {
        const localUrl = saveBase64ToDisk(this.uploadsDir, b64Extract, "image/png");
        if (localUrl) return localUrl;
        return `data:image/png;base64,${b64Extract}`;
      }

      return null;
    } catch (err) {
      console.error("[ExtractArtwork] exception:", err?.message);
      return null;
    }
  }

  createDesignRecord({ shopDomain, prompt, productType, publishImmediately, artworkPrompt, designImageUrl, createdBy }) {
    const now = Date.now();
    return {
      id: randomUUID(),
      shopDomain,
      prompt,
      productType,
      createdBy: createdBy || null,
      publishImmediately,
      status: "preview_ready",
      artworkPrompt,
      currentDesignAssetId: "",
      revisionCount: 0,
      createdAt: now,
      updatedAt: now,
      finalizedAt: null,
      shopifyProductId: "",
      adminUrl: "",
      previewImageUrl: designImageUrl,
      rawArtworkUrl: designImageUrl,
    };
  }
}

module.exports = {
  PodPipelineService,
};
