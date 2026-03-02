/**
 * Printful Mockup Generator Service
 *
 * Uses the Printful API to generate product mockups from artwork images.
 * Free with a Printful account — no per-image cost.
 *
 * Docs: https://developers.printful.com/docs/#tag/Mockup-Generator-API
 */

const path = require("path");
const fs = require("fs");
const log = require("../utils/logger");

const PRINTFUL_BASE = "https://api.printful.com";

// Map our product types to Printful product IDs
const PRODUCT_MAP = {
  tshirt:      { productId: 71,  variant: "front",  label: "Unisex Staple T-Shirt (Bella+Canvas 3001)" },
  hoodie:      { productId: 146, variant: "front",  label: "Unisex Heavy Blend Hoodie (Gildan 18500)" },
  sweatshirt:  { productId: 281, variant: "front",  label: "Unisex Premium Sweatshirt (Cotton Heritage M2480)" },
  mug:         { productId: 19,  variant: "front",  label: "White Glossy Mug" },
  poster:      { productId: 1,   variant: "default",label: "Enhanced Matte Paper Poster" },
  canvasprint: { productId: 3,   variant: "default",label: "Canvas Print" },
  pillow:      { productId: 83,  variant: "front",  label: "All-Over Print Pillow" },
  totebag:     { productId: 297, variant: "front",  label: "AOP Tote Bag" },
};

class PrintfulMockupService {
  constructor(uploadsDir) {
    this.uploadsDir = uploadsDir || path.join(__dirname, "..", "..", "data", "uploads");
  }

  /**
   * Generate a product mockup via Printful's Mockup Generator API.
   *
   * @param {object} opts
   * @param {string} opts.printfulApiKey  – Printful API token
   * @param {string} opts.artworkUrl      – Public URL (or data-URI) of the artwork image
   * @param {string} opts.productType     – One of our product type keys (tshirt, mug, etc.)
   * @param {number} [opts.maxWaitMs]     – Max polling time (default 60s)
   * @param {number} [opts.pollIntervalMs]– Polling interval (default 3s)
   * @returns {{ mockupUrls: string[], provider: string, providerMessage: string }}
   */
  async generateMockup({ printfulApiKey, artworkUrl, productType, printfulProductId, maxWaitMs = 60000, pollIntervalMs = 3000 }) {
    if (!printfulApiKey || !String(printfulApiKey).trim()) {
      return {
        mockupUrls: [],
        provider: "printful-no-key",
        providerMessage: "Printful API key is not configured.",
      };
    }

    // Allow direct Printful product ID or fallback to our mapping
    const mapping = printfulProductId
      ? { productId: Number(printfulProductId), variant: "front", label: `Printful #${printfulProductId}` }
      : PRODUCT_MAP[productType];
    if (!mapping) {
      return {
        mockupUrls: [],
        provider: "printful-unsupported",
        providerMessage: `Product type "${productType}" is not mapped to a Printful product.`,
      };
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${printfulApiKey}`,
    };

    // If artwork is a data URI or local file, we need to upload it to Printful first
    let imageUrl = artworkUrl;
    if (String(artworkUrl).startsWith("/uploads/")) {
      // Convert local file to data URI then upload
      const localPath = path.join(this.uploadsDir, path.basename(artworkUrl));
      if (fs.existsSync(localPath)) {
        const buffer = fs.readFileSync(localPath);
        const ext = path.extname(localPath).toLowerCase();
        const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
        const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;
        imageUrl = await this._uploadDataUri(dataUri, printfulApiKey);
      } else {
        imageUrl = null;
      }
      if (!imageUrl) {
        return {
          mockupUrls: [],
          provider: "printful-upload-failed",
          providerMessage: "Failed to read local artwork file for Printful upload.",
        };
      }
    } else if (String(artworkUrl).startsWith("data:")) {
      imageUrl = await this._uploadDataUri(artworkUrl, printfulApiKey);
      if (!imageUrl) {
        return {
          mockupUrls: [],
          provider: "printful-upload-failed",
          providerMessage: "Failed to prepare artwork image for Printful.",
        };
      }
    }

    try {
      // Step 1: Get available print files / placement info
      const printfilesRes = await fetch(
        `${PRINTFUL_BASE}/mockup-generator/printfiles/${mapping.productId}`,
        { headers }
      );
      if (!printfilesRes.ok) {
        const err = await printfilesRes.json().catch(() => ({}));
        log.error({ err }, "Printful printfiles error");
        return {
          mockupUrls: [],
          provider: "printful-error",
          providerMessage: `Failed to get Printful print file info: ${err?.error?.message || printfilesRes.status}`,
        };
      }
      const printfilesData = await printfilesRes.json();

      // Find a variant ID to use (pick the first available)
      const availableVariants = printfilesData?.result?.variant_ids || [];
      const variantId = availableVariants[0];
      if (!variantId) {
        return {
          mockupUrls: [],
          provider: "printful-no-variant",
          providerMessage: "No variants available for this Printful product.",
        };
      }

      // Determine the placement key (e.g. "front", "default")
      const printfiles = printfilesData?.result?.printfiles || [];
      const placementKey = printfiles.length > 0
        ? (printfiles.find(p => p.printfile_id)?.printfile_id ? mapping.variant : (printfiles[0]?.type || "default"))
        : mapping.variant;

      // Step 2: Create mock-up generation task
      const taskBody = {
        variant_ids: [variantId],
        files: [
          {
            placement: placementKey,
            image_url: imageUrl,
            position: {
              area_width: 1800,
              area_height: 2400,
              width: 1800,
              height: 2400,
              top: 0,
              left: 0,
            },
          },
        ],
      };

      log.info({ productId: mapping.productId, label: mapping.label, variantId }, "Creating Printful mockup task");
      const createRes = await fetch(
        `${PRINTFUL_BASE}/mockup-generator/create-task/${mapping.productId}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(taskBody),
        }
      );

      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        log.error({ err }, "Printful create-task error");
        return {
          mockupUrls: [],
          provider: "printful-error",
          providerMessage: `Printful mockup task creation failed: ${err?.error?.message || createRes.status}`,
        };
      }

      const createData = await createRes.json();
      const taskKey = createData?.result?.task_key;
      if (!taskKey) {
        return {
          mockupUrls: [],
          provider: "printful-error",
          providerMessage: "Printful did not return a task key.",
        };
      }

      // Step 3: Poll for completion
      log.debug({ taskKey }, "Polling Printful task");
      const startTime = Date.now();
      while (Date.now() - startTime < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        const statusRes = await fetch(
          `${PRINTFUL_BASE}/mockup-generator/task?task_key=${encodeURIComponent(taskKey)}`,
          { headers }
        );
        if (!statusRes.ok) {
          continue; // retry
        }

        const statusData = await statusRes.json();
        const status = statusData?.result?.status;

        if (status === "completed") {
          const mockups = statusData?.result?.mockups || [];
          const mockupUrls = mockups.flatMap((m) =>
            (m.extra || []).map((e) => e.url).concat(m.mockup_url ? [m.mockup_url] : [])
          );

          if (mockupUrls.length === 0) {
            // Try alternate structure
            const altUrls = mockups.map((m) => m.mockup_url).filter(Boolean);
            if (altUrls.length > 0) {
              return {
                mockupUrls: altUrls,
                provider: "printful",
                providerMessage: `Printful mockup generated: ${mapping.label}. ${altUrls.length} image(s).`,
              };
            }
          }

          log.info({ imageCount: mockupUrls.length }, "Printful mockup complete");
          return {
            mockupUrls,
            provider: "printful",
            providerMessage: `Printful mockup generated: ${mapping.label}. ${mockupUrls.length} image(s).`,
          };
        }

        if (status === "failed") {
          const errMsg = statusData?.result?.error || "Unknown error";
          log.error({ errMsg }, "Printful task failed");
          return {
            mockupUrls: [],
            provider: "printful-failed",
            providerMessage: `Printful mockup generation failed: ${errMsg}`,
          };
        }
        // else "pending" — keep polling
      }

      return {
        mockupUrls: [],
        provider: "printful-timeout",
        providerMessage: `Printful mockup generation timed out after ${maxWaitMs / 1000}s.`,
      };
    } catch (error) {
      log.error({ err: error?.message }, "Printful exception");
      return {
        mockupUrls: [],
        provider: "printful-exception",
        providerMessage: error instanceof Error ? error.message : "Printful request failed.",
      };
    }
  }

  /**
   * Upload a data-URI artwork image to Printful's File Library.
   * Returns the hosted preview URL, or null on failure.
   */
  async _uploadDataUri(dataUri, apiKey) {
    try {
      const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) {
        log.warn({}, "Printful: could not parse data URI");
        return null;
      }

      const mimeType = match[1];
      const base64Data = match[2];
      const buffer = Buffer.from(base64Data, "base64");

      const ext = mimeType.includes("png") ? "png" : "jpg";
      const filename = `artwork_${Date.now()}.${ext}`;
      const blob = new Blob([buffer], { type: mimeType });

      const formData = new FormData();
      formData.append("file", blob, filename);
      formData.append("type", "default");

      log.info({ sizeKB: (buffer.length / 1024).toFixed(0) }, "Uploading artwork to Printful File Library");

      const res = await fetch(`${PRINTFUL_BASE}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        log.error({ status: res.status, err }, "Printful file upload error");
        return null;
      }

      const data = await res.json();
      const result = data?.result;
      const url = result?.preview_url || result?.url;

      if (url) {
        log.info({ fileId: result?.id, urlPreview: url.substring(0, 100) }, "Printful artwork uploaded");
      } else {
        log.warn({ responsePreview: JSON.stringify(data).substring(0, 200) }, "Printful file uploaded but no URL returned");
      }

      return url || null;
    } catch (error) {
      log.error({ err: error?.message }, "Printful file upload exception");
      return null;
    }
  }

  /**
   * Fetch the FULL Printful product catalog (all 400+ products) in one API call.
   * Cached in memory for 1 hour.
   *
   * @param {string} printfulApiKey
   * @returns {{ products: Array<{ id, title, type, image, model }>, categories: string[], source: string }}
   */
  async getProductCatalog(printfulApiKey) {
    if (!printfulApiKey) {
      return { products: [], categories: [], source: "no-key" };
    }

    // Return cached if fresh
    if (this._catalogCache && Date.now() - this._catalogCacheTime < 3600000) {
      return { products: this._catalogCache, categories: this._catalogCategories, source: "cache" };
    }

    try {
      const res = await fetch(`${PRINTFUL_BASE}/products`, {
        headers: { Authorization: `Bearer ${printfulApiKey}` },
      });

      if (!res.ok) {
        log.error({ status: res.status }, "Printful catalog fetch failed");
        return { products: [], categories: [], source: "error" };
      }

      const data = await res.json();
      const rawProducts = data?.result || [];

      // Gather nice category labels & map products
      const categorySet = new Set();
      const CATEGORY_LABELS = {
        "T-SHIRT": "T-Shirts",
        "CUT-SEW": "Cut & Sew",
        "EMBROIDERY": "Embroidery",
        "SUBLIMATION": "Sublimation",
        "POSTCARD": "Postcards",
        "DECOR": "Home Decor",
        "PHONE-CASE": "Phone Cases",
        "DRINKWARE": "Drinkware",
        "SHOES": "Shoes",
        "DTFILM": "DTFilm",
        "KNITWEAR": "Knitwear",
        "STICKER": "Stickers",
        "MUG": "Mugs",
        "FRAMED-POSTER": "Framed Posters",
        "DIRECT-TO-FABRIC": "Fabric",
        "COSMETICS": "Cosmetics",
        "CANVAS": "Canvas",
        "POSTER": "Posters",
        "PUZZLE": "Puzzles",
        "CANDLE": "Candles",
        "EMBROIDERY-PATCH": "Patches",
      };

      const products = rawProducts.map((p) => {
        const cat = CATEGORY_LABELS[p.type] || p.type;
        categorySet.add(cat);
        return {
          id: p.id,
          title: p.title,
          type: p.type,
          category: cat,
          image: p.image || null,
          model: p.model || null,
        };
      });

      const categories = Array.from(categorySet).sort();

      this._catalogCache = products;
      this._catalogCategories = categories;
      this._catalogCacheTime = Date.now();

      log.info({ productCount: products.length, categoryCount: categories.length }, "Printful catalog fetched");
      return { products, categories, source: "api" };
    } catch (err) {
      log.error({ err: err?.message }, "Printful catalog exception");
      return { products: [], categories: [], source: "error" };
    }
  }

  /**
   * Check if a product type is supported by Printful mapping.
   */
  isSupported(productType) {
    return Boolean(PRODUCT_MAP[productType]);
  }

  /**
   * Get the Printful product info for a product type.
   */
  getProductInfo(productType) {
    return PRODUCT_MAP[productType] || null;
  }
}

module.exports = { PrintfulMockupService };
