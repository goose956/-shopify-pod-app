import { useState, useCallback, useEffect } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  Form,
  FormLayout,
  Icon,
  InlineGrid,
  InlineStack,
  Link,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  ImageIcon,
  EditIcon,
  CheckIcon,
  ProductIcon,
} from "@shopify/polaris-icons";
import { getSessionToken } from "../utils/sessionToken";
import { DesignLibrary } from "./DesignLibrary";
import { AdminDashboard } from "./AdminDashboard";

function buildDefaultLifestylePrompt(productType, index) {
  const defaults = [
    `${productType} lifestyle scene on a kitchen table with natural daylight`,
    `${productType} lifestyle scene placed on a clean floor setup`,
    `${productType} lifestyle scene with someone holding the product`,
  ];
  return defaults[index] || `${productType} lifestyle scene variation ${index + 1}`;
}

function openImageFullSize(url) {
  if (!url) return;
  // For data URIs or blob URLs, create a new window with an embedded img tag
  // since window.open(dataUri) shows blank in most browsers
  const win = window.open("", "_blank");
  if (win) {
    win.document.write(`<!DOCTYPE html><html><head><title>Full Size Image</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a1a;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="${url}" alt="Full size" /></body></html>`);
    win.document.close();
  }
}

function ImagePreviewCard({ imageUrl, label, size = "medium", onOpen }) {
  const [imgError, setImgError] = useState(false);
  const widths = { small: 120, medium: 200, large: 280 };
  const w = widths[size] || widths.medium;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        background: "#f6f6f7",
        border: "1px solid #e1e3e5",
        borderRadius: 12,
        padding: 12,
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      {!imgError && imageUrl ? (
        <img
          src={imageUrl}
          alt={label}
          onError={() => setImgError(true)}
          style={{
            width: "100%",
            maxWidth: w,
            height: "auto",
            maxHeight: w,
            objectFit: "contain",
            borderRadius: 8,
            display: "block",
          }}
        />
      ) : (
        <div style={{
          width: "100%", maxWidth: w, height: w,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "#e1e3e5", borderRadius: 8, color: "#666", fontSize: 12,
          textAlign: "center", padding: 16,
        }}>
          {imgError ? "Image failed to load" : "No image"}
        </div>
      )}
      {label && (
        <Text variant="bodySm" tone="subdued" as="p" alignment="center">
          {label}
        </Text>
      )}
      {onOpen && (
        <Button size="slim" onClick={onOpen} variant="plain">
          Open full size
        </Button>
      )}
    </div>
  );
}

export function ProductGenerator() {
  const [selectedTab, setSelectedTab] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [productType, setProductType] = useState("tshirt");
  const [imageShape, setImageShape] = useState("square");
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [isGeneratingDesign, setIsGeneratingDesign] = useState(false);
  const [isGeneratingMockup, setIsGeneratingMockup] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [designId, setDesignId] = useState("");
  const [designImageUrl, setDesignImageUrl] = useState("");
  const [rawArtworkUrl, setRawArtworkUrl] = useState("");
  const [providerStatus, setProviderStatus] = useState(null);
  const [amendment, setAmendment] = useState("");
  const [lifestyleImages, setLifestyleImages] = useState([]);
  const [lifestyleImageCount, setLifestyleImageCount] = useState("3");
  const [lifestylePrompts, setLifestylePrompts] = useState([
    buildDefaultLifestylePrompt("tshirt", 0),
    buildDefaultLifestylePrompt("tshirt", 1),
    buildDefaultLifestylePrompt("tshirt", 2),
  ]);
  const [listingCopy, setListingCopy] = useState(null);
  const [transparentArtworkUrl, setTransparentArtworkUrl] = useState("");
  const [finalProduct, setFinalProduct] = useState(null);
  const [error, setError] = useState(null);
  const [inputMode, setInputMode] = useState("describe");

  const [referenceImage, setReferenceImage] = useState(null);
  const [referencePreview, setReferencePreview] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState("");
  const [winningPrompt, setWinningPrompt] = useState("");
  const [winningProductType, setWinningProductType] = useState("tshirt");
  const [winningImageShape, setWinningImageShape] = useState("square");
  const [winningPublishImmediately, setWinningPublishImmediately] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [catalogProducts, setCatalogProducts] = useState([]);
  const [catalogCategories, setCatalogCategories] = useState([]);
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogCategory, setCatalogCategory] = useState("All");
  const [selectedPrintfulId, setSelectedPrintfulId] = useState(null);
  const [selectedPrintfulTitle, setSelectedPrintfulTitle] = useState("");
  const [productSourceMode, setProductSourceMode] = useState("dropdown");

  const handleProductTypeChange = useCallback((value) => {
    setProductType(value);
    setSelectedPrintfulId(null);
    setSelectedPrintfulTitle("");
  }, []);
  const handleImageShapeChange = useCallback((value) => setImageShape(value), []);

  // Fetch full Printful catalog once
  useEffect(() => {
    let cancelled = false;
    async function loadCatalog() {
      try {
        setIsCatalogLoading(true);
        const token = await getSessionToken();
        const res = await fetch("/api/printful-catalog", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.products?.length) {
          setCatalogProducts(data.products);
          setCatalogCategories(data.categories || []);
        }
      } catch (_) { /* silent */ }
      finally { if (!cancelled) setIsCatalogLoading(false); }
    }
    loadCatalog();
    return () => { cancelled = true; };
  }, []);

  // Check if API keys are configured (onboarding)
  useEffect(() => {
    let cancelled = false;
    async function checkSetup() {
      try {
        const token = await getSessionToken();
        const res = await fetch("/api/settings", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setSetupNeeded(!data.settings?.hasOpenAiKey && !data.settings?.hasKieAiKey);
        }
      } catch (_) { /* silent */ }
    }
    checkSetup();
    return () => { cancelled = true; };
  }, []);

  // Select a product from the Printful catalog
  const handleCatalogSelect = useCallback((product, setter) => {
    setSelectedPrintfulId(product.id);
    setSelectedPrintfulTitle(product.title);
    // Map Printful category to our product type dropdown as best we can
    const typeMap = {
      "T-SHIRT": "tshirt", "CUT-SEW": "tshirt", "DTFILM": "tshirt",
      "EMBROIDERY": "hoodie", "KNITWEAR": "sweatshirt",
      "MUG": "mug", "DRINKWARE": "mug",
      "POSTER": "poster", "FRAMED-POSTER": "poster", "POSTCARD": "poster",
      "CANVAS": "canvasprint",
      "DECOR": "pillow",
    };
    const mapped = typeMap[product.type] || "tshirt";
    setter(mapped);
  }, []);

  // Filter catalog products by search + category
  const filteredCatalog = catalogProducts.filter((p) => {
    if (catalogCategory !== "All" && p.category !== catalogCategory) return false;
    if (catalogSearch.trim()) {
      const q = catalogSearch.toLowerCase();
      return p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q);
    }
    return true;
  });
  const handleLifestyleImageCountChange = useCallback((value) => {
    const nextCount = Math.max(1, Math.min(6, Number(value) || 1));
    setLifestyleImageCount(String(nextCount));
    setLifestylePrompts((prev) => {
      const next = prev.slice(0, nextCount);
      while (next.length < nextCount) next.push("");
      return next;
    });
  }, []);
  const handleLifestylePromptChange = useCallback((index, value) => {
    setLifestylePrompts((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const productTypeOptions = [
    { label: "T-shirt", value: "tshirt" },
    { label: "Hoodie", value: "hoodie" },
    { label: "Sweatshirt", value: "sweatshirt" },
    { label: "Mug", value: "mug" },
    { label: "Poster", value: "poster" },
    { label: "Canvas Print", value: "canvas" },
    { label: "Pillow", value: "pillow" },
    { label: "Tote Bag", value: "totebag" },
  ];
  const imageShapeOptions = [
    { label: "Square (1:1)", value: "square" },
    { label: "Portrait (3:4)", value: "portrait" },
    { label: "Landscape (4:3)", value: "landscape" },
    { label: "Tall Portrait (2:3)", value: "tall_portrait" },
    { label: "Wide Landscape (3:2)", value: "wide_landscape" },
  ];
  const lifestyleCountOptions = ["1", "2", "3", "4", "5", "6"].map((v) => ({ label: v, value: v }));

  // Determine which tabs are unlocked
  const hasDesign = Boolean(designId && (rawArtworkUrl || designImageUrl));
  const hasLifestyle = lifestyleImages.length > 0;
  const hasPublished = Boolean(finalProduct?.adminUrl);
  const hasFinalized = Boolean(finalProduct);

  const workflowSteps = [
    { id: "describe", label: "Describe", icon: "\u270F\uFE0F", done: hasDesign, disabled: false },
    { id: "preview", label: "Preview", icon: "\uD83D\uDDBC\uFE0F", done: hasLifestyle, disabled: !hasDesign },
    { id: "lifestyle", label: "Product Images", icon: "\uD83D\uDCF8", done: hasFinalized, disabled: !hasLifestyle },
    { id: "published", label: hasPublished ? "Published" : "Results", icon: hasPublished ? "\u2705" : "\uD83D\uDCCB", done: false, disabled: !hasFinalized },
  ];

  // Polaris Tabs data kept for reference
  const tabDisabled = [false, !hasDesign, !hasLifestyle, !hasFinalized, false];

  const handleTabChange = useCallback((index) => {
    if (!tabDisabled[index]) {
      setSelectedTab(index);
    }
  }, [hasDesign, hasLifestyle, hasFinalized]);

  const handleReferenceImageSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setReferenceImage(file);
    const reader = new FileReader();
    reader.onload = () => setReferencePreview(reader.result);
    reader.readAsDataURL(file);
    setAnalysisResult("");
  }, []);

  const handleAnalyzeImage = async () => {
    if (!referencePreview) return;
    setIsAnalyzing(true);
    setError(null);
    try {
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/analyze-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
        body: JSON.stringify({ imageBase64: referencePreview }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to analyze image.");
      }
      const data = await response.json();
      setAnalysisResult(data.description || "");
      setWinningPrompt(data.description || "");
    } catch (err) {
      setError(err.message || "Failed to analyze image.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleWinningProductTypeChange = useCallback((value) => setWinningProductType(value), []);
  const handleWinningImageShapeChange = useCallback((value) => setWinningImageShape(value), []);

  const handleGenerateDesign = async () => {
    setError(null);
    setDesignImageUrl("");
    setRawArtworkUrl("");
    setDesignId("");
    setLifestyleImages([]);
    setListingCopy(null);
    setTransparentArtworkUrl("");
    setFinalProduct(null);
    setProviderStatus(null);
    const requestedCount = Math.max(1, Math.min(6, Number(lifestyleImageCount) || 3));
    setLifestylePrompts(
      Array.from({ length: requestedCount }, (_, i) => buildDefaultLifestylePrompt(productType, i))
    );
    setIsGeneratingDesign(true);
    try {
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/design-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
        body: JSON.stringify({ prompt, productType, imageShape, publishImmediately }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to generate design preview.");
      }
      const data = await response.json();
      setDesignId(data.designId);
      setRawArtworkUrl(data.rawArtworkUrl || "");
      setDesignImageUrl("");
      setProviderStatus((prev) => ({
        ...(prev || {}),
        designImage: data.provider?.designImage || "unknown",
        message: data.provider?.message || "",
      }));
      // Auto-advance to Preview tab
      setSelectedTab(1);
    } catch (err) {
      setError(err.message || "Failed to generate design preview.");
    } finally {
      setIsGeneratingDesign(false);
    }
  };

  const handleReviseDesign = async () => {
    setError(null);
    setIsGeneratingDesign(true);
    try {
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/revise-design", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
        body: JSON.stringify({ designId, amendment }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to revise design.");
      }
      const data = await response.json();
      setRawArtworkUrl(data.rawArtworkUrl || data.designImageUrl || rawArtworkUrl);
      setDesignImageUrl("");
      setAmendment("");
      setProviderStatus((prev) => ({
        ...(prev || {}),
        designImage: data.provider?.designImage || "unknown",
        message: data.provider?.message || "",
      }));
    } catch (err) {
      setError(err.message || "Failed to revise design.");
    } finally {
      setIsGeneratingDesign(false);
    }
  };

  const handleGenerateMockup = async () => {
    setError(null);
    setIsGeneratingMockup(true);
    try {
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/generate-mockup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
        body: JSON.stringify({ designId, imageShape, printfulProductId: selectedPrintfulId }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to generate product mockup.");
      }
      const data = await response.json();
      setDesignImageUrl(data.designImageUrl);
      setProviderStatus((prev) => ({
        ...(prev || {}),
        mockup: data.provider?.designImage || "unknown",
        mockupMessage: data.provider?.message || "",
      }));
    } catch (err) {
      setError(err.message || "Failed to generate product mockup.");
    } finally {
      setIsGeneratingMockup(false);
    }
  };

  const handleApproveAndFinalize = async () => {
    setError(null);
    setIsFinalizing(true);
    try {
      const sessionToken = await getSessionToken();
      const requestedCount = Math.max(1, Math.min(6, Number(lifestyleImageCount) || 3));
      const selectedLifestylePrompts = Array.from({ length: requestedCount }, (_, i) => {
        const custom = String(lifestylePrompts[i] || "").trim();
        return custom || buildDefaultLifestylePrompt(productType, i);
      });
      const response = await fetch("/api/finalize-product", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
        body: JSON.stringify({ designId, publishImmediately, lifestylePrompts: selectedLifestylePrompts }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to finalize product.");
      }
      const data = await response.json();
      setLifestyleImages(data.lifestyleImages || []);
      setListingCopy(data.listingCopy || null);
      setTransparentArtworkUrl(data.transparentArtworkUrl || "");
      setProviderStatus((prev) => ({
        ...(prev || {}),
        lifestyleImages: data.provider?.lifestyleImages || "unknown",
        listingCopy: data.provider?.listingCopy || "unknown",
        message: data.provider?.message || prev?.message || "",
      }));
      setFinalProduct({ adminUrl: data.adminUrl, productId: data.productId, publishError: data.publishError || null });
      // Auto-advance to Lifestyle tab
      setSelectedTab(2);
    } catch (err) {
      setError(err.message || "Failed to finalize product.");
    } finally {
      setIsFinalizing(false);
    }
  };

  const isWorking = isGeneratingDesign || isGeneratingMockup || isFinalizing;

  return (
    <BlockStack gap="400">
      {/* Custom tab bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
        {/* Workflow steps */}
        <div style={{
          display: "flex",
          border: "1px solid #e3e5e7",
          borderRadius: 8,
          overflow: "hidden",
          background: "#f6f6f7",
        }}>
          {workflowSteps.map((step, i) => {
            const isActive = selectedTab === i;
            const isDone = step.done;
            const isDisabled = step.disabled;
            return (
              <button
                key={step.id}
                onClick={() => !isDisabled && setSelectedTab(i)}
                disabled={isDisabled}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 16px",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 500,
                  color: isDisabled ? "#b5b5b5" : isActive ? "#fff" : "#303030",
                  background: isActive ? "#005bd3" : "transparent",
                  border: "none",
                  borderRight: i < workflowSteps.length - 1 ? "1px solid #e3e5e7" : "none",
                  cursor: isDisabled ? "default" : "pointer",
                  transition: "all 0.12s ease",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ fontSize: 14 }}>{step.icon}</span>
                {step.label}
                {isDone && (
                  <span style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 16, height: 16, borderRadius: 3,
                    background: isActive ? "rgba(255,255,255,0.25)" : "#005bd3",
                    color: "#fff", fontSize: 10, fontWeight: 700,
                  }}>{"\u2713"}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Spacer / gap */}
        <div style={{ width: 16 }} />

        {/* Utility tabs - separate */}
        <div style={{
          display: "flex",
          border: "1px solid #e3e5e7",
          borderRadius: 8,
          overflow: "hidden",
          background: "#f6f6f7",
        }}>
          <button
            onClick={() => setSelectedTab(4)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: selectedTab === 4 ? 600 : 500,
              color: selectedTab === 4 ? "#fff" : "#303030",
              background: selectedTab === 4 ? "#005bd3" : "transparent",
              border: "none",
              borderRight: "1px solid #e3e5e7",
              cursor: "pointer",
              transition: "all 0.12s ease",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ fontSize: 14 }}>{"\uD83D\uDCDA"}</span>
            Library
          </button>
          <button
            onClick={() => setSelectedTab(5)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: selectedTab === 5 ? 600 : 500,
              color: selectedTab === 5 ? "#fff" : "#303030",
              background: selectedTab === 5 ? "#005bd3" : "transparent",
              border: "none",
              cursor: "pointer",
              transition: "all 0.12s ease",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ fontSize: 14 }}>{"\u2699\uFE0F"}</span>
            Admin
          </button>
        </div>
      </div>

      {/* Error banner -- always visible */}
      {error && (
        <Banner tone="critical" title="Something went wrong" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Banner>
      )}

      {/* Onboarding banner */}
      {setupNeeded && selectedTab === 0 && (
        <Banner
          tone="warning"
          title="Set up your API keys to start generating designs"
          action={{ content: "Go to Admin", onAction: () => setSelectedTab(5) }}
        >
          <p>Add an OpenAI or KIE.ai API key in the Admin tab to enable AI design generation.</p>
        </Banner>
      )}

      {/* Tab 1: Describe */}
      {selectedTab === 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Left: Manual prompt */}
          <div
            onClick={() => setInputMode("describe")}
            style={{
              borderRadius: 12,
              border: inputMode === "describe" ? "2px solid #005bd3" : "2px solid #e3e5e7",
              background: inputMode === "describe" ? "#f0f7ff" : "#fff",
              transition: "all 0.15s ease",
              opacity: inputMode === "describe" ? 1 : 0.55,
              cursor: inputMode === "describe" ? "default" : "pointer",
              minWidth: 0, overflow: "hidden",
            }}
          >
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="200" blockAlign="center" align="space-between">
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: inputMode === "describe" ? "#005bd3" : "#e8f5ff", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" }}>
                      <Icon source={ImageIcon} tone={inputMode === "describe" ? "base" : "info"} />
                    </div>
                    <Text variant="headingMd" as="h2" fontWeight="semibold">Describe Your Product</Text>
                  </InlineStack>
                  <div
                    style={{
                      width: 20, height: 20, borderRadius: 10,
                      border: inputMode === "describe" ? "2px solid #005bd3" : "2px solid #c9cccf",
                      background: inputMode === "describe" ? "#005bd3" : "#fff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      transition: "all 0.15s ease", flexShrink: 0,
                    }}
                  >
                    {inputMode === "describe" && <div style={{ width: 8, height: 8, borderRadius: 4, background: "#fff" }} />}
                  </div>
                </InlineStack>

                <Form onSubmit={handleGenerateDesign}>
                  <FormLayout>
                    <TextField
                      value={prompt}
                      onChange={setPrompt}
                      label="Product concept"
                      helpText="Describe the style, subject, and mood you want for this product."
                      placeholder="e.g. vintage surfer astronaut tee, retro sunset colour palette"
                      multiline={3}
                      autoComplete="off"
                    />
                    <div>
                      <div style={{ marginBottom: 4 }}><Text variant="bodyMd" as="label" fontWeight="semibold">Product type</Text></div>
                      {catalogProducts.length > 0 && (
                        <div style={{ display: "flex", gap: 0, marginBottom: 8, borderRadius: 8, overflow: "hidden", border: "1px solid #c9cccf" }}>
                          <button type="button" onClick={(e) => { e.stopPropagation(); setProductSourceMode("dropdown"); setSelectedPrintfulId(null); setSelectedPrintfulTitle(""); }} style={{ flex: 1, padding: "7px 0", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer", background: productSourceMode === "dropdown" ? "#005bd3" : "#f6f6f7", color: productSourceMode === "dropdown" ? "#fff" : "#555", transition: "all 0.15s" }}>Quick Select</button>
                          <button type="button" onClick={(e) => { e.stopPropagation(); setProductSourceMode("printful"); }} style={{ flex: 1, padding: "7px 0", fontSize: 13, fontWeight: 600, border: "none", borderLeft: "1px solid #c9cccf", cursor: "pointer", background: productSourceMode === "printful" ? "#005bd3" : "#f6f6f7", color: productSourceMode === "printful" ? "#fff" : "#555", transition: "all 0.15s" }}>Printful Catalog ({catalogProducts.length})</button>
                        </div>
                      )}
                      {productSourceMode === "dropdown" && (
                        <Select label="" options={productTypeOptions} onChange={handleProductTypeChange} value={productType} />
                      )}
                      {productSourceMode === "printful" && (
                        <div>
                          {selectedPrintfulId && (
                            <div style={{ padding: "6px 10px", background: "#e8f5ff", borderRadius: 6, fontSize: 12, color: "#005bd3", marginBottom: 8 }}>
                              Selected: <strong>{selectedPrintfulTitle}</strong>
                              <button type="button" onClick={(e) => { e.stopPropagation(); setSelectedPrintfulId(null); setSelectedPrintfulTitle(""); }} style={{ marginLeft: 8, background: "none", border: "none", color: "#bf0711", cursor: "pointer", fontSize: 12 }}>Clear</button>
                            </div>
                          )}
                          <input
                            type="text"
                            value={catalogSearch}
                            onChange={(e) => setCatalogSearch(e.target.value)}
                            placeholder="Search 468 products..."
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              width: "100%", padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 6,
                              fontSize: 13, marginBottom: 8, outline: "none", boxSizing: "border-box",
                            }}
                          />
                          <div style={{ display: "flex", gap: 4, overflowX: "auto", marginBottom: 8, paddingBottom: 4 }}>
                            <button type="button" onClick={(e) => { e.stopPropagation(); setCatalogCategory("All"); }} style={{ padding: "3px 8px", borderRadius: 12, border: catalogCategory === "All" ? "2px solid #005bd3" : "1px solid #c9cccf", background: catalogCategory === "All" ? "#005bd3" : "#fff", color: catalogCategory === "All" ? "#fff" : "#333", fontSize: 11, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0 }}>All</button>
                            {catalogCategories.map((cat) => (
                              <button key={cat} type="button" onClick={(e) => { e.stopPropagation(); setCatalogCategory(cat); }} style={{ padding: "3px 8px", borderRadius: 12, border: catalogCategory === cat ? "2px solid #005bd3" : "1px solid #c9cccf", background: catalogCategory === cat ? "#005bd3" : "#fff", color: catalogCategory === cat ? "#fff" : "#333", fontSize: 11, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0 }}>{cat}</button>
                            ))}
                          </div>
                          <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
                            {filteredCatalog.slice(0, 60).map((cp) => (
                              <div
                                key={cp.id}
                                onClick={(e) => { e.stopPropagation(); handleCatalogSelect(cp, setProductType); }}
                                style={{
                                  border: selectedPrintfulId === cp.id ? "2px solid #005bd3" : "1px solid #e3e5e7",
                                  borderRadius: 6, padding: 4, cursor: "pointer", textAlign: "center",
                                  background: selectedPrintfulId === cp.id ? "#f0f7ff" : "#fff",
                                  transition: "all 0.12s", overflow: "hidden",
                                }}
                              >
                                {cp.image ? (
                                  <img src={cp.image} alt={cp.title} style={{ width: "100%", height: 44, objectFit: "contain", borderRadius: 4 }} loading="lazy" />
                                ) : (
                                  <div style={{ width: "100%", height: 44, background: "#f3f3f3", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#888" }}>No img</div>
                                )}
                                <div style={{ fontSize: 9, fontWeight: 500, marginTop: 2, lineHeight: 1.2, color: selectedPrintfulId === cp.id ? "#005bd3" : "#333", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {cp.title.split("|")[0].trim()}
                                </div>
                              </div>
                            ))}
                            {filteredCatalog.length === 0 && <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 12, color: "#888", fontSize: 12 }}>No products match</div>}
                            {filteredCatalog.length > 60 && <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 6, color: "#888", fontSize: 10 }}>Showing 60 of {filteredCatalog.length} — narrow search</div>}
                          </div>
                        </div>
                      )}
                    </div>
                    <Select label="Image shape" options={imageShapeOptions} onChange={handleImageShapeChange} value={imageShape} />
                    <Checkbox label="Publish to Shopify immediately" checked={publishImmediately} onChange={setPublishImmediately} />
                    {inputMode === "describe" && (
                      <Button submit variant="primary" loading={isGeneratingDesign} disabled={!prompt.trim() || isWorking} size="large">
                        Generate Design
                      </Button>
                    )}
                  </FormLayout>
                </Form>
              </BlockStack>
            </Card>
          </div>

          {/* Right: Winning product */}
          <div
            onClick={() => setInputMode("winning")}
            style={{
              borderRadius: 12,
              border: inputMode === "winning" ? "2px solid #005bd3" : "2px solid #e3e5e7",
              background: inputMode === "winning" ? "#f0f7ff" : "#fff",
              transition: "all 0.15s ease",
              opacity: inputMode === "winning" ? 1 : 0.55,
              cursor: inputMode === "winning" ? "default" : "pointer",
              minWidth: 0, overflow: "hidden",
            }}
          >
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="200" blockAlign="center" align="space-between">
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: inputMode === "winning" ? "#005bd3" : "#fff8e6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, transition: "background 0.15s", color: inputMode === "winning" ? "#fff" : "inherit" }}>🏆</div>
                    <Text variant="headingMd" as="h2" fontWeight="semibold">Winning Product</Text>
                  </InlineStack>
                  <div
                    style={{
                      width: 20, height: 20, borderRadius: 10,
                      border: inputMode === "winning" ? "2px solid #005bd3" : "2px solid #c9cccf",
                      background: inputMode === "winning" ? "#005bd3" : "#fff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      transition: "all 0.15s ease", flexShrink: 0,
                    }}
                  >
                    {inputMode === "winning" && <div style={{ width: 8, height: 8, borderRadius: 4, background: "#fff" }} />}
                  </div>
                </InlineStack>
                <Text variant="bodySm" tone="subdued" as="p">
                  Upload a winning product image. AI analyses the design and creates an editable prompt.
                </Text>

                  {/* Drop zone */}
                  <div
                    style={{
                      border: "2px dashed #c9cccf",
                      borderRadius: 12,
                      padding: referencePreview ? 12 : 32,
                      textAlign: "center",
                      background: "#f9fafb",
                      cursor: "pointer",
                      transition: "border-color 0.15s",
                      position: "relative",
                    }}
                    onClick={() => { document.getElementById("ref-image-input")?.click(); setInputMode("winning"); }}
                    onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "#005bd3"; }}
                    onDragLeave={(e) => { e.currentTarget.style.borderColor = "#c9cccf"; }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.style.borderColor = "#c9cccf";
                      const file = e.dataTransfer.files?.[0];
                      if (file && file.type.startsWith("image/")) {
                        setReferenceImage(file);
                        const reader = new FileReader();
                        reader.onload = () => setReferencePreview(reader.result);
                        reader.readAsDataURL(file);
                        setAnalysisResult("");
                        setWinningPrompt("");
                        setInputMode("winning");
                      }
                    }}
                  >
                    <input
                      id="ref-image-input"
                      type="file"
                      accept="image/*"
                      style={{ display: "none" }}
                      onChange={(e) => { handleReferenceImageSelect(e); setWinningPrompt(""); setInputMode("winning"); }}
                    />
                    {referencePreview ? (
                      <img src={referencePreview} alt="Reference" style={{ maxWidth: "100%", maxHeight: 160, borderRadius: 8, objectFit: "contain" }} />
                    ) : (
                      <BlockStack gap="200" inlineAlign="center">
                        <div style={{ fontSize: 32, opacity: 0.4 }}>📷</div>
                        <Text variant="bodySm" tone="subdued" as="p">Drop an image here or click to browse</Text>
                      </BlockStack>
                    )}
                  </div>

                  {referencePreview && !analysisResult && (
                    <InlineStack gap="300">
                      <Button onClick={handleAnalyzeImage} loading={isAnalyzing} disabled={isAnalyzing} variant="primary">
                        Analyse Design
                      </Button>
                      <Button onClick={() => { setReferenceImage(null); setReferencePreview(""); setAnalysisResult(""); setWinningPrompt(""); }} variant="plain" tone="critical">
                        Remove
                      </Button>
                    </InlineStack>
                  )}

                  {analysisResult && (
                    <BlockStack gap="300">
                      <TextField
                        value={winningPrompt}
                        onChange={setWinningPrompt}
                        label="AI-generated prompt (PLEASE EDIT to make your own ORIGINAL product)"
                        multiline={3}
                        autoComplete="off"
                        helpText="Generated from your image. Edit before generating."
                      />
                      <div>
                        <div style={{ marginBottom: 4 }}><Text variant="bodyMd" as="label" fontWeight="semibold">Product type</Text></div>
                        {catalogProducts.length > 0 && (
                          <div style={{ display: "flex", gap: 0, marginBottom: 8, borderRadius: 8, overflow: "hidden", border: "1px solid #c9cccf" }}>
                            <button type="button" onClick={(e) => { e.stopPropagation(); setProductSourceMode("dropdown"); setSelectedPrintfulId(null); setSelectedPrintfulTitle(""); }} style={{ flex: 1, padding: "7px 0", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer", background: productSourceMode === "dropdown" ? "#005bd3" : "#f6f6f7", color: productSourceMode === "dropdown" ? "#fff" : "#555", transition: "all 0.15s" }}>Quick Select</button>
                            <button type="button" onClick={(e) => { e.stopPropagation(); setProductSourceMode("printful"); }} style={{ flex: 1, padding: "7px 0", fontSize: 13, fontWeight: 600, border: "none", borderLeft: "1px solid #c9cccf", cursor: "pointer", background: productSourceMode === "printful" ? "#005bd3" : "#f6f6f7", color: productSourceMode === "printful" ? "#fff" : "#555", transition: "all 0.15s" }}>Printful Catalog ({catalogProducts.length})</button>
                          </div>
                        )}
                        {productSourceMode === "dropdown" && (
                          <Select label="" options={productTypeOptions} onChange={handleWinningProductTypeChange} value={winningProductType} />
                        )}
                        {productSourceMode === "printful" && (
                          <div>
                            {selectedPrintfulId && (
                              <div style={{ padding: "6px 10px", background: "#e8f5ff", borderRadius: 6, fontSize: 12, color: "#005bd3", marginBottom: 8 }}>
                                Selected: <strong>{selectedPrintfulTitle}</strong>
                                <button type="button" onClick={(e) => { e.stopPropagation(); setSelectedPrintfulId(null); setSelectedPrintfulTitle(""); }} style={{ marginLeft: 8, background: "none", border: "none", color: "#bf0711", cursor: "pointer", fontSize: 12 }}>Clear</button>
                              </div>
                            )}
                            <input
                              type="text"
                              value={catalogSearch}
                              onChange={(e) => setCatalogSearch(e.target.value)}
                              placeholder="Search 468 products..."
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                width: "100%", padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 6,
                                fontSize: 13, marginBottom: 8, outline: "none", boxSizing: "border-box",
                              }}
                            />
                            <div style={{ display: "flex", gap: 4, overflowX: "auto", marginBottom: 8, paddingBottom: 4 }}>
                              <button type="button" onClick={(e) => { e.stopPropagation(); setCatalogCategory("All"); }} style={{ padding: "3px 8px", borderRadius: 12, border: catalogCategory === "All" ? "2px solid #005bd3" : "1px solid #c9cccf", background: catalogCategory === "All" ? "#005bd3" : "#fff", color: catalogCategory === "All" ? "#fff" : "#333", fontSize: 11, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0 }}>All</button>
                              {catalogCategories.map((cat) => (
                                <button key={cat} type="button" onClick={(e) => { e.stopPropagation(); setCatalogCategory(cat); }} style={{ padding: "3px 8px", borderRadius: 12, border: catalogCategory === cat ? "2px solid #005bd3" : "1px solid #c9cccf", background: catalogCategory === cat ? "#005bd3" : "#fff", color: catalogCategory === cat ? "#fff" : "#333", fontSize: 11, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0 }}>{cat}</button>
                              ))}
                            </div>
                            <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
                              {filteredCatalog.slice(0, 60).map((cp) => (
                                <div
                                  key={cp.id}
                                  onClick={(e) => { e.stopPropagation(); handleCatalogSelect(cp, setWinningProductType); }}
                                  style={{
                                    border: selectedPrintfulId === cp.id ? "2px solid #005bd3" : "1px solid #e3e5e7",
                                    borderRadius: 6, padding: 4, cursor: "pointer", textAlign: "center",
                                    background: selectedPrintfulId === cp.id ? "#f0f7ff" : "#fff",
                                    transition: "all 0.12s", overflow: "hidden",
                                  }}
                                >
                                  {cp.image ? (
                                    <img src={cp.image} alt={cp.title} style={{ width: "100%", height: 44, objectFit: "contain", borderRadius: 4 }} loading="lazy" />
                                  ) : (
                                    <div style={{ width: "100%", height: 44, background: "#f3f3f3", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#888" }}>No img</div>
                                  )}
                                  <div style={{ fontSize: 9, fontWeight: 500, marginTop: 2, lineHeight: 1.2, color: selectedPrintfulId === cp.id ? "#005bd3" : "#333", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {cp.title.split("|")[0].trim()}
                                  </div>
                                </div>
                              ))}
                              {filteredCatalog.length === 0 && <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 12, color: "#888", fontSize: 12 }}>No products match</div>}
                              {filteredCatalog.length > 60 && <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 6, color: "#888", fontSize: 10 }}>Showing 60 of {filteredCatalog.length} — narrow search</div>}
                            </div>
                          </div>
                        )}
                      </div>
                      <Select label="Image shape" options={imageShapeOptions} onChange={handleWinningImageShapeChange} value={winningImageShape} />
                      <Checkbox label="Publish to Shopify immediately" checked={winningPublishImmediately} onChange={setWinningPublishImmediately} />
                      <InlineStack gap="300">
                        {inputMode === "winning" && (
                          <Button
                            variant="primary"
                            loading={isGeneratingDesign}
                            disabled={!winningPrompt.trim() || isWorking}
                            size="large"
                            onClick={async () => {
                              setError(null);
                              setDesignImageUrl("");
                              setRawArtworkUrl("");
                              setDesignId("");
                              setLifestyleImages([]);
                              setListingCopy(null);
                              setTransparentArtworkUrl("");
                              setFinalProduct(null);
                              setProviderStatus(null);
                              const requestedCount = Math.max(1, Math.min(6, Number(lifestyleImageCount) || 3));
                              setLifestylePrompts(
                                Array.from({ length: requestedCount }, (_, i) => buildDefaultLifestylePrompt(winningProductType, i))
                              );
                              setProductType(winningProductType);
                              setImageShape(winningImageShape);
                              setPublishImmediately(winningPublishImmediately);
                              setIsGeneratingDesign(true);
                              try {
                                const sessionToken = await getSessionToken();
                                const response = await fetch("/api/design-preview", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
                                  body: JSON.stringify({ prompt: winningPrompt, productType: winningProductType, imageShape: winningImageShape, publishImmediately: winningPublishImmediately }),
                                });
                                if (!response.ok) {
                                  const data = await response.json().catch(() => ({}));
                                  throw new Error(data.error || "Failed to generate design preview.");
                                }
                                const data = await response.json();
                                setDesignId(data.designId);
                                setDesignImageUrl("");
                                setRawArtworkUrl(data.rawArtworkUrl || "");
                                setProviderStatus((prev) => ({
                                  ...(prev || {}),
                                  designImage: data.provider?.designImage || "unknown",
                                  message: data.provider?.message || "",
                                }));
                                setPrompt(winningPrompt);
                                setSelectedTab(1);
                              } catch (err) {
                                setError(err.message || "Failed to generate design preview.");
                              } finally {
                                setIsGeneratingDesign(false);
                              }
                            }}
                          >
                            Generate from Winning Product
                          </Button>
                        )}
                        <Button onClick={() => { setReferenceImage(null); setReferencePreview(""); setAnalysisResult(""); setWinningPrompt(""); }} variant="plain" tone="critical">
                          Clear
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </div>
          </div>
      )}

      {/* Tab 2: Preview & Revise */}
      {selectedTab === 1 && (rawArtworkUrl || designImageUrl) && (
        <BlockStack gap="400">
          {/* Artwork preview + revision controls */}
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "#e8f5ff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon source={EditIcon} tone="info" />
                </div>
                <Text variant="headingMd" as="h2" fontWeight="semibold">
                  {designImageUrl ? "Design Preview" : "Artwork Preview"}
                </Text>
              </InlineStack>

              <BlockStack gap="500">
                <InlineStack gap="500" blockAlign="start" wrap>
                  <ImagePreviewCard
                    imageUrl={rawArtworkUrl || designImageUrl}
                    label="Raw Artwork"
                    size="large"
                    onOpen={() => openImageFullSize(rawArtworkUrl || designImageUrl)}
                  />
                  {designImageUrl && (
                    <ImagePreviewCard
                      imageUrl={designImageUrl}
                      label="Product Mockup"
                      size="large"
                      onOpen={() => openImageFullSize(designImageUrl)}
                    />
                  )}
                </InlineStack>
                {!designImageUrl && (
                  <BlockStack gap="300">
                    <Text variant="headingSm" as="h3">Request a change</Text>
                    <TextField
                      value={amendment}
                      onChange={setAmendment}
                      label=""
                      placeholder="e.g. make the shamrock darker, add a distressed texture"
                      multiline={2}
                      autoComplete="off"
                    />
                    <div>
                      <button
                        onClick={handleReviseDesign}
                        disabled={!amendment.trim() || isWorking}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "6px 14px",
                          fontSize: 13,
                          fontWeight: 500,
                          color: (!amendment.trim() || isWorking) ? "#8c9196" : "#2c6ecb",
                          background: (!amendment.trim() || isWorking) ? "#f6f6f7" : "#f1f8ff",
                          border: `1px solid ${(!amendment.trim() || isWorking) ? "#e1e3e5" : "#b4d5fe"}`,
                          borderRadius: 8,
                          cursor: (!amendment.trim() || isWorking) ? "not-allowed" : "pointer",
                          transition: "all 0.15s ease",
                        }}
                        onMouseEnter={(e) => {
                          if (!e.currentTarget.disabled) {
                            e.currentTarget.style.background = "#e0f0ff";
                            e.currentTarget.style.borderColor = "#2c6ecb";
                            e.currentTarget.style.transform = "translateY(-1px)";
                            e.currentTarget.style.boxShadow = "0 2px 6px rgba(44,110,203,0.18)";
                          }
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = e.currentTarget.disabled ? "#f6f6f7" : "#f1f8ff";
                          e.currentTarget.style.borderColor = e.currentTarget.disabled ? "#e1e3e5" : "#b4d5fe";
                          e.currentTarget.style.transform = "none";
                          e.currentTarget.style.boxShadow = "none";
                        }}
                      >
                        {isGeneratingDesign ? "Revising..." : "Revise Artwork"}
                      </button>
                    </div>
                  </BlockStack>
                )}
              </BlockStack>

              {/* Approve artwork → generate mockup */}
              {!designImageUrl && (
                <>
                  <Divider />
                  <InlineStack gap="300" blockAlign="center">
                    <Button
                      variant="primary"
                      onClick={handleGenerateMockup}
                      loading={isGeneratingMockup}
                      disabled={isWorking}
                      size="large"
                    >
                      {isGeneratingMockup ? "Generating Mockup..." : "Happy with Artwork \u2014 Generate Product Mockup"}
                    </Button>
                    <Button onClick={() => setSelectedTab(0)} disabled={isWorking}>
                      Back to Describe
                    </Button>
                  </InlineStack>
                </>
              )}
            </BlockStack>
          </Card>

          {/* Lifestyle config + approve — only show after mockup is ready */}
          {designImageUrl && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2" fontWeight="semibold">Lifestyle Image Settings</Text>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <Select
                  label="Number of lifestyle images"
                  options={lifestyleCountOptions}
                  onChange={handleLifestyleImageCountChange}
                  value={lifestyleImageCount}
                />
              </InlineGrid>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                {Array.from({ length: Math.max(1, Math.min(6, Number(lifestyleImageCount) || 3)) }).map((_, i) => (
                  <TextField
                    key={`lifestyle-prompt-${i}`}
                    label={`Scene ${i + 1}`}
                    value={lifestylePrompts[i] || ""}
                    onChange={(v) => handleLifestylePromptChange(i, v)}
                    placeholder={buildDefaultLifestylePrompt(productType, i)}
                    multiline={2}
                    autoComplete="off"
                  />
                ))}
              </InlineGrid>
              <Divider />
              <InlineStack gap="300" blockAlign="center">
                <Button
                  variant="primary"
                  icon={CheckIcon}
                  onClick={handleApproveAndFinalize}
                  loading={isFinalizing}
                  disabled={isWorking}
                  size="large"
                >
                  Approve & Create Product
                </Button>
                <Button onClick={() => setSelectedTab(0)} disabled={isWorking}>
                  Back to Describe
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
          )}
        </BlockStack>
      )}

      {/* Tab 3: Lifestyle Images + Copy */}
      {selectedTab === 2 && hasLifestyle && (
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center" align="space-between">
                <Text variant="headingMd" as="h2" fontWeight="semibold">Lifestyle Images</Text>
                <Text variant="bodySm" tone="subdued" as="p">{lifestyleImages.length} image{lifestyleImages.length !== 1 ? "s" : ""}</Text>
              </InlineStack>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                  gap: 12,
                }}
              >
                {lifestyleImages.map((imageUrl, index) => (
                  <ImagePreviewCard
                    key={imageUrl + index}
                    imageUrl={imageUrl}
                    label={`Lifestyle ${index + 1}`}
                    size="medium"
                    onOpen={() => openImageFullSize(imageUrl)}
                  />
                ))}
              </div>
            </BlockStack>
          </Card>

          {/* Transparent Artwork PNG */}
          {transparentArtworkUrl && (
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="200" blockAlign="center" align="space-between">
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: "#f3f0ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🎨</div>
                    <Text variant="headingMd" as="h2" fontWeight="semibold">Isolated Artwork (Transparent PNG)</Text>
                  </InlineStack>
                </InlineStack>
                <div style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: 16,
                  background: "repeating-conic-gradient(#e5e5e5 0% 25%, #fff 0% 50%) 0 0 / 20px 20px",
                  borderRadius: 12,
                  border: "1px solid #e1e3e5",
                }}>
                  <img
                    src={transparentArtworkUrl}
                    alt="Isolated artwork"
                    style={{ maxWidth: 320, maxHeight: 320, objectFit: "contain" }}
                  />
                </div>
                <Text variant="bodySm" tone="subdued" as="p">
                  This is the isolated design artwork with a transparent background — ready to use with your POD provider.
                </Text>
              </BlockStack>
            </Card>
          )}

          {listingCopy && (
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2" fontWeight="semibold">Listing Copy</Text>
                <Box background="bg-surface-secondary" borderRadius="300" padding="400" borderWidth="025" borderColor="border">
                  <BlockStack gap="300">
                    <BlockStack gap="100">
                      <Text variant="headingSm" as="h3" tone="subdued">Title</Text>
                      <Text variant="bodyLg" fontWeight="semibold" as="p">{listingCopy.title}</Text>
                    </BlockStack>
                    <Divider />
                    <BlockStack gap="100">
                      <Text variant="headingSm" as="h3" tone="subdued">Description</Text>
                      <Text variant="bodyMd" as="p">{listingCopy.descriptionText}</Text>
                    </BlockStack>
                    <Divider />
                    <BlockStack gap="100">
                      <Text variant="headingSm" as="h3" tone="subdued">Tags</Text>
                      <InlineStack gap="200" wrap>
                        {(listingCopy.tags || []).map((tag) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                      </InlineStack>
                    </BlockStack>
                  </BlockStack>
                </Box>
              </BlockStack>
            </Card>
          )}

          <InlineStack gap="300">
            {hasFinalized && (
              <Button variant="primary" onClick={() => setSelectedTab(3)}>
                {hasPublished ? "View Published Product" : "View Results"}
              </Button>
            )}
            <Button onClick={() => setSelectedTab(1)}>
              Back to Preview
            </Button>
          </InlineStack>
        </BlockStack>
      )}

      {/* Tab 4: Published */}
      {selectedTab === 3 && hasFinalized && (
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
              {hasPublished ? (
                <>
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: "#f0fff4", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon source={ProductIcon} tone="success" />
                    </div>
                    <Text variant="headingMd" as="h2" fontWeight="semibold">Product Created</Text>
                    <Badge tone="success">Live</Badge>
                  </InlineStack>
                  <Banner tone="success">
                    <p>
                      Your product is ready.{" "}
                      <Link url={finalProduct.adminUrl} target="_blank">View in Shopify Admin</Link>
                    </p>
                    {finalProduct.productId && (
                      <p>Product ID: {finalProduct.productId}</p>
                    )}
                  </Banner>
                </>
              ) : (
                <>
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: "#fffbe6", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon source={ProductIcon} tone="warning" />
                    </div>
                    <Text variant="headingMd" as="h2" fontWeight="semibold">Design Finalized</Text>
                    <Badge tone="warning">Not Published</Badge>
                  </InlineStack>
                  <Banner tone="warning">
                    <p>
                      Lifestyle images and listing copy were generated successfully, but publishing to Shopify failed: {finalProduct.publishError || "No valid Shopify access token. Complete the OAuth install flow to enable publishing."}
                    </p>
                  </Banner>
                </>
              )}
            </BlockStack>
          </Card>

          <InlineStack gap="300">
            <Button onClick={() => setSelectedTab(2)}>
              View Lifestyle Images
            </Button>
            <Button onClick={() => setSelectedTab(4)}>
              View Library
            </Button>
            <Button variant="primary" onClick={() => {
              setSelectedTab(0);
              setDesignId("");
              setDesignImageUrl("");
              setRawArtworkUrl("");
              setLifestyleImages([]);
              setListingCopy(null);
              setTransparentArtworkUrl("");
              setFinalProduct(null);
              setProviderStatus(null);
              setAmendment("");
              setError(null);
            }}>
              Create Another Product
            </Button>
          </InlineStack>

          {/* Downloads section */}
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "#f3f0ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>📥</div>
                <Text variant="headingMd" as="h2" fontWeight="semibold">Download Files</Text>
              </InlineStack>
              <InlineStack gap="300" wrap>
                {(transparentArtworkUrl || rawArtworkUrl) && (
                  <Button
                    onClick={() => {
                      const url = transparentArtworkUrl || rawArtworkUrl;
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `artwork-${designId}.png`;
                      a.target = "_blank";
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    }}
                    variant="primary"
                  >
                    Download Artwork PNG
                  </Button>
                )}
                {designImageUrl && (
                  <Button
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = designImageUrl;
                      a.download = `mockup-${designId}.png`;
                      a.target = "_blank";
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    }}
                  >
                    Download Product Mockup
                  </Button>
                )}
                {lifestyleImages.map((url, i) => (
                  <Button
                    key={`dl-${i}`}
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `lifestyle-${designId}-${i + 1}.png`;
                      a.target = "_blank";
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    }}
                  >
                    Download Lifestyle {i + 1}
                  </Button>
                ))}
              </InlineStack>
            </BlockStack>
          </Card>
        </BlockStack>
      )}

      {/* Tab 5: Library */}
      {selectedTab === 4 && (
        <DesignLibrary />
      )}

      {/* Tab 6: Admin */}
      {selectedTab === 5 && (
        <AdminDashboard />
      )}
    </BlockStack>
  );
}
