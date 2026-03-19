const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const log = require("../utils/logger");

/**
 * Save a base64 image to the database via store.saveImage().
 * Falls back to disk if store is not available (dev/JSON mode).
 */
async function saveBase64Image(store, shopDomain, base64Data, mimeType = "image/png") {
  try {
    const id = randomUUID();
    const buffer = Buffer.from(base64Data, "base64");

    if (store?.saveImage) {
      await store.saveImage({ id, shopDomain, data: buffer, mimeType });
      log.info({ sizeKB: (buffer.length / 1024).toFixed(0), id, shopDomain }, "Image saved to database");
      return `/images/${id}`;
    }

    // Fallback: save to disk (dev mode with JsonStore)
    const uploadsDir = path.join(__dirname, "..", "..", "data", "uploads");
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const ext = mimeType.includes("webp") ? "webp" : mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
    const filename = `${id}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
    log.info({ sizeKB: (buffer.length / 1024).toFixed(0), filename }, "Image saved to disk (fallback)");
    return `/uploads/${filename}`;
  } catch (err) {
    log.error({ err: err?.message }, "Failed to save base64 image");
    return null;
  }
}

/**
 * Download an external URL and save the image to the database.
 * Falls back to disk if store is not available.
 */
async function downloadAndSaveImage(store, shopDomain, imageUrl) {
  try {
    if (!imageUrl || typeof imageUrl !== "string") return null;
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) return null;

    const response = await fetch(imageUrl);
    if (!response.ok) {
      log.error({ status: response.status, url: imageUrl.slice(0, 80) }, "Failed to download image URL");
      return null;
    }
    const contentType = response.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());
    const id = randomUUID();

    if (store?.saveImage) {
      await store.saveImage({ id, shopDomain, data: buffer, mimeType: contentType });
      log.info({ sizeKB: (buffer.length / 1024).toFixed(0), id, shopDomain }, "Image downloaded and saved to database");
      return `/images/${id}`;
    }

    // Fallback: save to disk
    const uploadsDir = path.join(__dirname, "..", "..", "data", "uploads");
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const ext = contentType.includes("webp") ? "webp" : contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : "png";
    const filename = `${id}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
    log.info({ sizeKB: (buffer.length / 1024).toFixed(0), filename }, "Image downloaded to disk (fallback)");
    return `/uploads/${filename}`;
  } catch (err) {
    log.error({ err: err?.message }, "Failed to download and save image");
    return null;
  }
}

// Keep old functions for backward compatibility during transition
function saveBase64ToDisk(uploadsDir, base64Data, mimeType = "image/png") {
  try {
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const ext = mimeType.includes("webp") ? "webp" : mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
    const filename = `${randomUUID()}.${ext}`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
    log.info({ sizeKB: (Buffer.byteLength(base64Data, "base64") / 1024).toFixed(0), filename }, "Image saved to disk");
    return `/uploads/${filename}`;
  } catch (err) {
    log.error({ err: err?.message }, "Failed to save base64 image to disk");
    return null;
  }
}

async function downloadUrlToDisk(uploadsDir, imageUrl) {
  try {
    if (!imageUrl || typeof imageUrl !== "string") return null;
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) return null;
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const response = await fetch(imageUrl);
    if (!response.ok) {
      log.error({ status: response.status, url: imageUrl.slice(0, 80) }, "Failed to download image URL");
      return null;
    }
    const contentType = response.headers.get("content-type") || "image/png";
    const ext = contentType.includes("webp") ? "webp" : contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : "png";
    const filename = `${randomUUID()}.${ext}`;
    const filePath = path.join(uploadsDir, filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    log.info({ sizeKB: (buffer.length / 1024).toFixed(0), filename }, "Image downloaded to disk");
    return `/uploads/${filename}`;
  } catch (err) {
    log.error({ err: err?.message }, "Failed to download URL to disk");
    return null;
  }
}

class PodPipelineService {
  constructor(uploadsDir, store) {
    this.uploadsDir = uploadsDir || path.join(__dirname, "..", "..", "data", "uploads");
    this.store = store || null;
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

  // dall-e-3 only supports 1024x1024, 1024x1792, 1792x1024
  getDallE3Size(imageShape) {
    const sizeMap = {
      square: "1024x1024",
      portrait: "1024x1792",
      landscape: "1792x1024",
      tall_portrait: "1024x1792",
      wide_landscape: "1792x1024",
    };
    return sizeMap[imageShape] || "1024x1024";
  }

  // dall-e-2 only supports 256x256, 512x512, 1024x1024
  getDallE2Size() {
    return "1024x1024";
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
      log.error({ err: err?.message }, "AnalyzeImage exception");
      throw err;
    }
  }

  _placeholderDataUri(text) {
    const escaped = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#e0e0e0"/><text x="50%" y="50%" font-family="sans-serif" font-size="24" fill="#888" text-anchor="middle" dominant-baseline="middle">${escaped.slice(0, 60)}</text></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  async generateDesignImage({ artworkPrompt, openAiApiKey, keiAiApiKey, kieGenerateUrl, referenceImageUrl, imageShape, maxWaitMs, pollIntervalMs, shopDomain }) {
    if (!this.isUsableApiKey(openAiApiKey)) {
      return {
        imageUrl: this._placeholderDataUri(artworkPrompt.slice(0, 48)),
        provider: "fallback-no-key",
        providerMessage: "OpenAI API key is missing or invalid.",
      };
    }

    let openAiImageUrl = null;
    let usedReferenceImage = false;

    if (referenceImageUrl) {
      log.info({ referenceImageUrl: String(referenceImageUrl).slice(0, 80), imageShape }, "generateDesignImage: attempting image edit with reference");
      openAiImageUrl = await this.generateOpenAiImageEdit({
        prompt: artworkPrompt,
        referenceImageUrl,
        openAiApiKey,
        imageShape,
        shopDomain,
      });
      usedReferenceImage = Boolean(openAiImageUrl);
      if (!usedReferenceImage) {
        log.warn({ referenceImageUrl: String(referenceImageUrl).slice(0, 80) }, "generateDesignImage: edit with reference FAILED, falling back to text-only");
      }
    }

    if (!openAiImageUrl) {
      const openAiPrompt = referenceImageUrl
        ? `${artworkPrompt}\n\nKeep the updated design very close to the previous version and apply only the requested change.`
        : artworkPrompt;

      openAiImageUrl = await this.generateOpenAiImage({
        prompt: openAiPrompt,
        openAiApiKey,
        imageShape,
        shopDomain,
      });
    }

    if (openAiImageUrl) {
      const providerMessage = usedReferenceImage
        ? "OpenAI image edit used. Reference image provided: true."
        : `OpenAI image generation used${referenceImageUrl ? " without reference image" : ""}. Reference image requested: ${Boolean(referenceImageUrl)}.`;

      return {
        imageUrl: openAiImageUrl,
        provider: "openai",
        providerMessage,
      };
    }

    return {
      imageUrl: this._placeholderDataUri(artworkPrompt.slice(0, 48)),
      provider: "fallback-error",
      providerMessage: "OpenAI image generation failed.",
    };
  }

  async generateOpenAiImage({ prompt, openAiApiKey, imageShape, shopDomain }) {
    if (!this.isUsableApiKey(openAiApiKey)) {
      log.warn({}, "OpenAI key missing or invalid — skipping image generation");
      return null;
    }

    const size = this.getOpenAiSize(imageShape);
    log.info({ size, promptLen: prompt.length }, "Calling OpenAI gpt-image-1 image generation");

    try {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({ model: "gpt-image-1", prompt, size, n: 1 }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        log.error({ status: response.status, detail: errBody?.error?.message }, "gpt-image-1 generation failed");
        return null;
      }

      this._trackCost({ provider: "openai", model: "gpt-image-1", operation: "generate" });

      const payload = await response.json();
      const url = payload?.data?.[0]?.url;
      if (url) {
        const savedUrl = await downloadAndSaveImage(this.store, shopDomain, url);
        return savedUrl || url;
      }

      const b64 = payload?.data?.[0]?.b64_json;
      if (b64) {
        const savedUrl = await saveBase64Image(this.store, shopDomain, b64, "image/png");
        if (savedUrl) return savedUrl;
        return `data:image/png;base64,${b64}`;
      }

      log.warn({}, "OpenAI returned OK but no image data");
      return null;
    } catch (err) {
      log.error({ err: err?.message }, "OpenAI generateOpenAiImage exception");
      return null;
    }
  }

  async generateOpenAiImageEdit({ prompt, referenceImageUrl, openAiApiKey, imageShape, shopDomain }) {
    if (!this.isUsableApiKey(openAiApiKey) || !String(referenceImageUrl || "").trim()) {
      log.warn({ hasKey: this.isUsableApiKey(openAiApiKey), hasRef: Boolean(referenceImageUrl) }, "generateOpenAiImageEdit: skipped (missing key or ref)");
      return null;
    }

    try {
      let imageBlob;
      let filename;

      if (String(referenceImageUrl).startsWith("data:")) {
        const match = referenceImageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) {
          log.warn({}, "OpenAI generateOpenAiImageEdit: invalid data-URI format");
          return null;
        }
        const mimeType = match[1];
        const base64Data = match[2];
        const buffer = Buffer.from(base64Data, "base64");
        imageBlob = new Blob([buffer], { type: mimeType });
        filename = `reference.${mimeType.includes("jpeg") ? "jpg" : "png"}`;
      } else if (String(referenceImageUrl).startsWith("/images/") && this.store?.getImage) {
        // Read from PostgreSQL images table
        const imageId = referenceImageUrl.replace("/images/", "");
        const imgRecord = await this.store.getImage(imageId);
        if (imgRecord) {
          imageBlob = new Blob([imgRecord.data], { type: imgRecord.mimeType });
          filename = `reference.${imgRecord.mimeType.includes("jpeg") ? "jpg" : "png"}`;
        } else {
          log.warn({ imageId }, "OpenAI generateOpenAiImageEdit: image not found in database");
          return null;
        }
      } else if (String(referenceImageUrl).startsWith("/uploads/")) {
        // Legacy: read from local uploads directory
        const localPath = path.join(this.uploadsDir, path.basename(referenceImageUrl));
        if (fs.existsSync(localPath)) {
          const buffer = fs.readFileSync(localPath);
          const ext = path.extname(localPath).toLowerCase();
          const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
          imageBlob = new Blob([buffer], { type: mimeType });
          filename = `reference${ext}`;
        } else {
          log.warn({ localPath }, "OpenAI generateOpenAiImageEdit: local file not found");
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

      const size = this.getOpenAiSize(imageShape);

      log.info({ blobSize: imageBlob?.size, filename, size, refUrl: String(referenceImageUrl).slice(0, 80) }, "generateOpenAiImageEdit: sending to OpenAI");

      const sendEdit = async () => {
        const form = new FormData();
        form.append("model", "gpt-image-1");
        form.append("prompt", prompt);
        form.append("size", size);
        form.append("image", imageBlob, filename);
        return fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { Authorization: `Bearer ${openAiApiKey}` },
          body: form,
        });
      };

      log.info({ model: "gpt-image-1", size, promptLen: prompt.length }, "Calling OpenAI image edit with reference image");
      const response = await sendEdit();

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        log.error({ status: response.status, detail: errBody?.error?.message }, "gpt-image-1 edit failed");
        return null;
      }

      this._trackCost({ provider: "openai", model: "gpt-image-1", operation: "edit" });

      const payload = await response.json();
      const url = payload?.data?.[0]?.url;
      if (url) {
        const savedUrl = await downloadAndSaveImage(this.store, shopDomain, url);
        return savedUrl || url;
      }

      const b64Edit = payload?.data?.[0]?.b64_json;
      if (b64Edit) {
        const savedUrl = await saveBase64Image(this.store, shopDomain, b64Edit, "image/png");
        if (savedUrl) return savedUrl;
        return `data:image/png;base64,${b64Edit}`;
      }

      return null;
    } catch (err) {
      log.error({ err: err?.message }, "OpenAI generateOpenAiImageEdit exception");
      return null;
    }
  }

  /**
   * Generate a mockup by sending both the artwork AND the custom product photo to OpenAI image edit.
   * Uses the multi-image capability of gpt-image-1 edits endpoint.
   */
  async generateMockupWithCustomProduct({ artworkUrl, customProductImageUrl, prompt, openAiApiKey, imageShape, shopDomain }) {
    if (!this.isUsableApiKey(openAiApiKey)) return null;

    try {
      const resolveBlob = async (url) => {
        if (String(url).startsWith("data:")) {
          const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
          if (!match) return null;
          return new Blob([Buffer.from(match[2], "base64")], { type: match[1] });
        }
        if (String(url).startsWith("/images/") && this.store?.getImage) {
          const rec = await this.store.getImage(url.replace("/images/", ""));
          if (rec) return new Blob([rec.data], { type: rec.mimeType });
          return null;
        }
        if (String(url).startsWith("/uploads/")) {
          const localPath = path.join(this.uploadsDir, path.basename(url));
          if (fs.existsSync(localPath)) {
            const buffer = fs.readFileSync(localPath);
            const ext = path.extname(localPath).toLowerCase();
            const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
            return new Blob([buffer], { type: mimeType });
          }
          return null;
        }
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.blob();
      };

      const [artworkBlob, productBlob] = await Promise.all([
        resolveBlob(artworkUrl),
        resolveBlob(customProductImageUrl),
      ]);

      if (!artworkBlob || !productBlob) {
        log.warn({ hasArtwork: Boolean(artworkBlob), hasProduct: Boolean(productBlob) }, "generateMockupWithCustomProduct: missing image blob");
        return null;
      }

      const size = this.getOpenAiSize(imageShape);
      const form = new FormData();
      form.append("model", "gpt-image-1");
      form.append("prompt", prompt);
      form.append("size", size);
      form.append("image[]", artworkBlob, "artwork.png");
      form.append("image[]", productBlob, "product.png");

      log.info({ artworkSize: artworkBlob.size, productSize: productBlob.size, size }, "generateMockupWithCustomProduct: calling OpenAI edits with 2 images");

      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${openAiApiKey}` },
        body: form,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        log.error({ status: response.status, detail: errBody?.error?.message }, "generateMockupWithCustomProduct: gpt-image-1 edit failed");
        return null;
      }

      this._trackCost({ provider: "openai", model: "gpt-image-1", operation: "edit" });

      const payload = await response.json();
      const url = payload?.data?.[0]?.url;
      if (url) {
        const savedUrl = await downloadAndSaveImage(this.store, shopDomain, url);
        return savedUrl || url;
      }
      const b64 = payload?.data?.[0]?.b64_json;
      if (b64) {
        const savedUrl = await saveBase64Image(this.store, shopDomain, b64, "image/png");
        if (savedUrl) return savedUrl;
        return `data:image/png;base64,${b64}`;
      }
      return null;
    } catch (err) {
      log.error({ err: err?.message }, "generateMockupWithCustomProduct exception");
      return null;
    }
  }

  async generateLifestyleImages({ productType, baseDesignImageUrl, designConcept, keiAiApiKey, kieEditUrl, openAiApiKey, stabilityApiKey, lifestylePrompts, maxWaitMs, pollIntervalMs, shopDomain }) {
    const defaultPrompts = [
      `Place this exact ${productType} product on a kitchen table in a bright room with natural daylight. Keep the product design exactly as shown in the reference image.`,
      `Show this exact ${productType} product in a clean, minimal flat-lay arrangement on a light surface. Keep the product design exactly as shown in the reference image.`,
      `Show a person holding this exact ${productType} product in a lifestyle setting. Keep the product design exactly as shown in the reference image.`,
    ];

    const hasReferenceImage = Boolean(baseDesignImageUrl);
    log.info({ productType, hasReferenceImage, referenceIsDataUri: String(baseDesignImageUrl || "").startsWith("data:") }, "Lifestyle generation starting (OpenAI)");

    const prompts = Array.isArray(lifestylePrompts)
      ? lifestylePrompts.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    const promptsToUse = prompts.length > 0 ? prompts : defaultPrompts;

    if (!this.isUsableApiKey(openAiApiKey)) {
      return {
        imageUrls: promptsToUse.map((prompt) => this._placeholderDataUri(prompt.slice(0, 60))),
        provider: "fallback-no-key",
        providerMessage: "OpenAI API key is missing or invalid.",
      };
    }

    const openAiResults = [];
    let usedReferenceImageCount = 0;
    for (const prompt of promptsToUse) {
      let imageUrl = null;
      if (baseDesignImageUrl) {
        log.debug({ promptPreview: prompt.slice(0, 60) }, "Attempting image edit with reference image");
        imageUrl = await this.generateOpenAiImageEdit({
          prompt,
          referenceImageUrl: baseDesignImageUrl,
          openAiApiKey,
          shopDomain,
        });
        if (imageUrl) {
          log.info({}, "Lifestyle image edit succeeded — reference design used");
          usedReferenceImageCount += 1;
        } else {
          log.warn({}, "Lifestyle image edit returned null — falling back to generation without reference");
        }
      }

      if (!imageUrl) {
        imageUrl = await this.generateOpenAiImage({
          prompt,
          openAiApiKey,
          shopDomain,
        });
      }

      if (imageUrl) {
        openAiResults.push(imageUrl);
      }
    }

    if (openAiResults.length > 0) {
      let providerMessage = "OpenAI lifestyle generation used.";
      if (usedReferenceImageCount === promptsToUse.length) {
        providerMessage = "OpenAI lifestyle image edits used with reference design image for all results.";
      } else if (usedReferenceImageCount > 0) {
        providerMessage = `OpenAI lifestyle generation used. Reference design image applied to ${usedReferenceImageCount}/${promptsToUse.length} results.`;
      } else if (baseDesignImageUrl) {
        providerMessage = "OpenAI lifestyle generation used without reference design image (edit API unavailable for this request).";
      }

      return {
        imageUrls: openAiResults,
        provider: "openai",
        providerMessage,
      };
    }

    return {
      imageUrls: promptsToUse.map((prompt) => this._placeholderDataUri(prompt.slice(0, 60))),
      provider: "fallback-error",
      providerMessage: "OpenAI image generation failed for all lifestyle images.",
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
        log.error({ status: response.status, detail: errBody?.error?.message }, "ExtractArtwork error");
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
      log.error({ err: err?.message }, "ExtractArtwork exception");
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
