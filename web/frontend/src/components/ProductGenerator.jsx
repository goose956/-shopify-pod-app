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

function ImagePreviewCard({ imageUrl, label, size = "medium", onOpen }) {
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
      }}
    >
      <img
        src={imageUrl}
        alt={label}
        style={{
          width: w,
          height: w,
          objectFit: "cover",
          borderRadius: 8,
          display: "block",
        }}
      />
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
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [isGeneratingDesign, setIsGeneratingDesign] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [designId, setDesignId] = useState("");
  const [designImageUrl, setDesignImageUrl] = useState("");
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
  const [winningPublishImmediately, setWinningPublishImmediately] = useState(false);

  const handleProductTypeChange = useCallback((value) => setProductType(value), []);
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
    { label: "Phone Case", value: "phonecase" },
    { label: "Tote Bag", value: "totebag" },
  ];
  const lifestyleCountOptions = ["1", "2", "3", "4", "5", "6"].map((v) => ({ label: v, value: v }));

  // Determine which tabs are unlocked
  const hasDesign = Boolean(designId && designImageUrl);
  const hasLifestyle = lifestyleImages.length > 0;
  const hasPublished = Boolean(finalProduct?.adminUrl);

  const workflowSteps = [
    { id: "describe", label: "Describe", icon: "\u270F\uFE0F", done: hasDesign, disabled: false },
    { id: "preview", label: "Preview", icon: "\uD83D\uDDBC\uFE0F", done: hasLifestyle, disabled: !hasDesign },
    { id: "lifestyle", label: "Lifestyle", icon: "\uD83D\uDCF8", done: hasPublished, disabled: !hasLifestyle },
    { id: "published", label: "Published", icon: "\u2705", done: false, disabled: !hasPublished },
  ];

  // Polaris Tabs data kept for reference
  const tabDisabled = [false, !hasDesign, !hasLifestyle, !hasPublished, false];

  const handleTabChange = useCallback((index) => {
    if (!tabDisabled[index]) {
      setSelectedTab(index);
    }
  }, [hasDesign, hasLifestyle, hasPublished]);

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

  const handleGenerateDesign = async () => {
    setError(null);
    setDesignImageUrl("");
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
        body: JSON.stringify({ prompt, productType, publishImmediately }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to generate design preview.");
      }
      const data = await response.json();
      setDesignId(data.designId);
      setDesignImageUrl(data.designImageUrl);
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
      setDesignImageUrl(data.designImageUrl);
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
      setFinalProduct({ adminUrl: data.adminUrl, productId: data.productId });
      // Auto-advance to Lifestyle tab
      setSelectedTab(2);
    } catch (err) {
      setError(err.message || "Failed to finalize product.");
    } finally {
      setIsFinalizing(false);
    }
  };

  const isWorking = isGeneratingDesign || isFinalizing;

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
                    <Select label="Product type" options={productTypeOptions} onChange={handleProductTypeChange} value={productType} />
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
                        label="AI-generated prompt (edit as needed)"
                        multiline={3}
                        autoComplete="off"
                        helpText="Generated from your image. Edit before generating."
                      />
                      <Select label="Product type" options={productTypeOptions} onChange={handleWinningProductTypeChange} value={winningProductType} />
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
                              setPublishImmediately(winningPublishImmediately);
                              setIsGeneratingDesign(true);
                              try {
                                const sessionToken = await getSessionToken();
                                const response = await fetch("/api/design-preview", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
                                  body: JSON.stringify({ prompt: winningPrompt, productType: winningProductType, publishImmediately: winningPublishImmediately }),
                                });
                                if (!response.ok) {
                                  const data = await response.json().catch(() => ({}));
                                  throw new Error(data.error || "Failed to generate design preview.");
                                }
                                const data = await response.json();
                                setDesignId(data.designId);
                                setDesignImageUrl(data.designImageUrl);
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
      {selectedTab === 1 && designImageUrl && (
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "#e8f5ff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon source={EditIcon} tone="info" />
                </div>
                <Text variant="headingMd" as="h2" fontWeight="semibold">Design Preview</Text>
              </InlineStack>

              <InlineStack gap="500" blockAlign="start" wrap>
                <ImagePreviewCard
                  imageUrl={designImageUrl}
                  label="Generated design"
                  size="large"
                  onOpen={() => window.open(designImageUrl, "_blank")}
                />
                <BlockStack gap="300" style={{ flex: 1, minWidth: 220 }}>
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
                      {isGeneratingDesign ? "Revising..." : "Revise Design"}
                    </button>
                  </div>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>

          {/* Lifestyle config + approve */}
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
                    onOpen={() => window.open(imageUrl, "_blank")}
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
                  <Button
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = transparentArtworkUrl;
                      a.download = `artwork-${designId}.png`;
                      a.target = "_blank";
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    }}
                    variant="primary"
                    size="slim"
                  >
                    Download PNG
                  </Button>
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
            {hasPublished && (
              <Button variant="primary" onClick={() => setSelectedTab(3)}>
                View Published Product
              </Button>
            )}
            <Button onClick={() => setSelectedTab(1)}>
              Back to Preview
            </Button>
          </InlineStack>
        </BlockStack>
      )}

      {/* Tab 4: Published */}
      {selectedTab === 3 && hasPublished && (
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
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
