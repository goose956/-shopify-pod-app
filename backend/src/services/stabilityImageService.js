const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * StabilityImageService — generates product-in-scene lifestyle images
 * using Stability AI's image-to-image API.
 *
 * Flow:
 *  1. Takes the product/artwork image as input
 *  2. Sends it with a scene prompt to Stability AI
 *  3. Stability renders the product naturally into the described scene
 *
 * Cost: ~$0.003–$0.006 per image vs ~$0.04–$0.08 with OpenAI
 */
class StabilityImageService {
  constructor(uploadsDir) {
    this.uploadsDir =
      uploadsDir || path.join(__dirname, "..", "..", "data", "uploads");
  }

  /**
   * Check if an API key looks valid.
   */
  isUsableKey(key) {
    const k = String(key || "").trim();
    return k.length > 10;
  }

  /**
   * Save raw image bytes to disk and return a /uploads/ path.
   */
  _saveToDisk(buffer, ext = "png") {
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
    const filename = `${randomUUID()}.${ext}`;
    const filePath = path.join(this.uploadsDir, filename);
    fs.writeFileSync(filePath, buffer);
    console.log(
      `[Stability] Saved ${(buffer.length / 1024).toFixed(0)}KB image → ${filename}`
    );
    return `/uploads/${filename}`;
  }

  /**
   * Load an image (local path, data URI, or remote URL) and return a Buffer.
   */
  async _loadImageBuffer(imageRef) {
    if (!imageRef) return null;

    // Data URI
    if (String(imageRef).startsWith("data:")) {
      const match = imageRef.match(/^data:image\/\w+;base64,(.+)$/);
      if (match) return Buffer.from(match[1], "base64");
      return null;
    }

    // Local /uploads/ path
    if (String(imageRef).startsWith("/uploads/")) {
      const localPath = path.join(
        this.uploadsDir,
        path.basename(imageRef)
      );
      if (fs.existsSync(localPath)) {
        return fs.readFileSync(localPath);
      }
      return null;
    }

    // Remote URL
    if (
      String(imageRef).startsWith("http://") ||
      String(imageRef).startsWith("https://")
    ) {
      const resp = await fetch(imageRef);
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    }

    return null;
  }

  /**
   * Generate a single product-in-scene image using Stability AI.
   *
   * Uses the "Search & Recolor" or "Image-to-Image" endpoint depending
   * on what's available. Primary target: /v2beta/stable-image/generate/sd3
   *
   * @param {Object} opts
   * @param {string} opts.stabilityApiKey - Stability AI API key
   * @param {string} opts.productImageRef - URL/path/data-URI of the product image
   * @param {string} opts.scenePrompt - Description of the scene to place the product in
   * @param {number} [opts.strength=0.55] - How much creative freedom (0=exact copy, 1=full reimagine)
   * @returns {string|null} Local /uploads/ path or null on failure
   */
  async generateSceneImage({
    stabilityApiKey,
    productImageRef,
    scenePrompt,
    strength = 0.55,
  }) {
    if (!this.isUsableKey(stabilityApiKey)) {
      console.warn("[Stability] API key missing or invalid");
      return null;
    }

    const imageBuffer = await this._loadImageBuffer(productImageRef);
    if (!imageBuffer) {
      console.warn("[Stability] Could not load product image for scene generation");
      return null;
    }

    // ── Try SD3 image-to-image first ──
    const result = await this._trySD3ImageToImage({
      stabilityApiKey,
      imageBuffer,
      scenePrompt,
      strength,
    });

    if (result) return result;

    // ── Fallback: SDXL image-to-image ──
    const sdxlResult = await this._trySDXLImageToImage({
      stabilityApiKey,
      imageBuffer,
      scenePrompt,
      strength,
    });

    return sdxlResult;
  }

  /**
   * SD3 image-to-image via Stability's v2beta API.
   */
  async _trySD3ImageToImage({
    stabilityApiKey,
    imageBuffer,
    scenePrompt,
    strength,
  }) {
    try {
      const formData = new FormData();
      const blob = new Blob([imageBuffer], { type: "image/png" });
      formData.append("image", blob, "product.png");
      formData.append("prompt", scenePrompt);
      formData.append("strength", String(Math.min(Math.max(strength, 0.2), 0.8)));
      formData.append("mode", "image-to-image");
      formData.append("output_format", "png");

      console.log(
        `[Stability] SD3 img2img request: prompt="${scenePrompt.slice(0, 80)}..." strength=${strength}`
      );

      const response = await fetch(
        "https://api.stability.ai/v2beta/stable-image/generate/sd3",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${stabilityApiKey}`,
            Accept: "image/*",
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        console.warn(
          `[Stability] SD3 img2img failed (${response.status}): ${errText.slice(0, 200)}`
        );
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1000) {
        console.warn("[Stability] SD3 returned suspiciously small image, skipping");
        return null;
      }

      return this._saveToDisk(buffer, "png");
    } catch (err) {
      console.warn("[Stability] SD3 img2img exception:", err?.message);
      return null;
    }
  }

  /**
   * SDXL image-to-image via Stability's v1 API (fallback).
   */
  async _trySDXLImageToImage({
    stabilityApiKey,
    imageBuffer,
    scenePrompt,
    strength,
  }) {
    try {
      const formData = new FormData();
      const blob = new Blob([imageBuffer], { type: "image/png" });
      formData.append("init_image", blob, "product.png");
      formData.append("init_image_mode", "IMAGE_STRENGTH");
      formData.append("image_strength", String(1 - Math.min(Math.max(strength, 0.2), 0.8)));
      formData.append("text_prompts[0][text]", scenePrompt);
      formData.append("text_prompts[0][weight]", "1");
      formData.append(
        "text_prompts[1][text]",
        "blurry, distorted, deformed, bad quality, watermark, text overlay"
      );
      formData.append("text_prompts[1][weight]", "-1");
      formData.append("cfg_scale", "7");
      formData.append("samples", "1");
      formData.append("steps", "30");

      console.log(
        `[Stability] SDXL img2img request: prompt="${scenePrompt.slice(0, 80)}..."`
      );

      const response = await fetch(
        "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${stabilityApiKey}`,
            Accept: "application/json",
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        console.warn(
          `[Stability] SDXL img2img failed (${response.status}): ${errText.slice(0, 200)}`
        );
        return null;
      }

      const payload = await response.json();
      const b64 = payload?.artifacts?.[0]?.base64;
      if (!b64) {
        console.warn("[Stability] SDXL returned no image data");
        return null;
      }

      const buffer = Buffer.from(b64, "base64");
      return this._saveToDisk(buffer, "png");
    } catch (err) {
      console.warn("[Stability] SDXL img2img exception:", err?.message);
      return null;
    }
  }

  /**
   * Generate multiple product-in-scene images (the lifestyle images pipeline).
   *
   * @param {Object} opts
   * @param {string} opts.stabilityApiKey
   * @param {string} opts.productImageRef - The product/design image
   * @param {string} opts.productType - e.g. "mug", "t-shirt"
   * @param {string[]} [opts.scenePrompts] - Custom prompts; defaults generated if omitted
   * @param {number} [opts.strength=0.55]
   * @returns {{ imageUrls: string[], provider: string, providerMessage: string }}
   */
  async generateProductImages({
    stabilityApiKey,
    productImageRef,
    productType,
    scenePrompts,
    strength = 0.55,
  }) {
    const defaultPrompts = [
      `Professional product photography of this ${productType} on a marble kitchen counter with soft morning sunlight streaming through a window. The ${productType} design is exactly preserved. Clean, bright, lifestyle photography style.`,
      `This ${productType} displayed in a cozy lifestyle flat-lay on a light wooden surface with minimal props like a plant and notebook. The ${productType} design is exactly preserved. Instagram-worthy product photography.`,
      `A person holding this ${productType} in a modern cafe setting with warm ambient lighting. The ${productType} design is exactly preserved. Natural, candid lifestyle product shot.`,
    ];

    const prompts =
      Array.isArray(scenePrompts) && scenePrompts.filter(Boolean).length > 0
        ? scenePrompts.filter(Boolean)
        : defaultPrompts;

    const results = [];
    let successCount = 0;

    for (const prompt of prompts) {
      const imageUrl = await this.generateSceneImage({
        stabilityApiKey,
        productImageRef,
        scenePrompt: prompt,
        strength,
      });

      if (imageUrl) {
        results.push(imageUrl);
        successCount++;
      } else {
        // Push null — caller can fill in with OpenAI fallback
        results.push(null);
      }
    }

    return {
      imageUrls: results,
      successCount,
      totalCount: prompts.length,
      provider: successCount === prompts.length ? "stability" : successCount > 0 ? "stability-partial" : "stability-failed",
      providerMessage:
        successCount === prompts.length
          ? `All ${prompts.length} product images generated via Stability AI (cost-optimised).`
          : successCount > 0
            ? `${successCount}/${prompts.length} product images generated via Stability AI. Remainder need fallback.`
            : "Stability AI generation failed for all images — falling back to OpenAI.",
    };
  }
}

module.exports = {
  StabilityImageService,
};
