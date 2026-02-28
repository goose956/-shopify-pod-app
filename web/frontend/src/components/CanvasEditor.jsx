import { useState, useRef, useEffect, useCallback } from "react";
import {
  Button,
  Text,
  TextField,
  Select,
  ColorPicker,
  InlineStack,
  BlockStack,
  Badge,
  Spinner,
} from "@shopify/polaris";
import {
  PlusIcon,
} from "@shopify/polaris-icons";
import * as fabric from "fabric";

/* ─── Google Fonts list (popular, diverse selection) ─────────────────────── */
const GOOGLE_FONTS = [
  "Arial",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Oswald",
  "Raleway",
  "Poppins",
  "Playfair Display",
  "Bebas Neue",
  "Lobster",
  "Pacifico",
  "Dancing Script",
  "Permanent Marker",
  "Caveat",
  "Abril Fatface",
  "Alfa Slab One",
  "Anton",
  "Archivo Black",
  "Bangers",
  "Barlow Condensed",
  "Bitter",
  "Black Ops One",
  "Bungee",
  "Cinzel",
  "Comfortaa",
  "Concert One",
  "Courgette",
  "Creepster",
  "Fredoka One",
  "Great Vibes",
  "Indie Flower",
  "Josefin Sans",
  "Kaushan Script",
  "Merriweather",
  "Monoton",
  "Nunito",
  "Orbitron",
  "Press Start 2P",
  "Righteous",
  "Russo One",
  "Sacramento",
  "Satisfy",
  "Shadows Into Light",
  "Special Elite",
  "Titan One",
  "Ubuntu",
  "Yanone Kaffeesatz",
  "Zilla Slab",
  "Impact",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Comic Sans MS",
  "Trebuchet MS",
];

const FONT_OPTIONS = GOOGLE_FONTS.map((f) => ({ label: f, value: f }));

/* ─── Load a Google Font dynamically ─────────────────────────────────────── */
const loadedFonts = new Set(["Arial", "Impact", "Georgia", "Times New Roman", "Courier New", "Verdana", "Comic Sans MS", "Trebuchet MS"]);

async function loadGoogleFont(fontName) {
  if (loadedFonts.has(fontName)) return;
  try {
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700;900&display=swap`;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);

    // Wait for the font to actually load
    await document.fonts.load(`16px "${fontName}"`);
    loadedFonts.add(fontName);
  } catch (e) {
    console.warn(`Failed to load font: ${fontName}`, e);
  }
}

/* ─── HSB → hex helper ──────────────────────────────────────────────────── */
function hsbToRgb(hsb) {
  const h = hsb.hue / 360;
  const s = hsb.saturation;
  const v = hsb.brightness;
  let r, g, b;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
    default: r = 0; g = 0; b = 0;
  }
  return { red: r, green: g, blue: b };
}

function hsbToHex(hsb) {
  const rgb = hsbToRgb(hsb);
  const toHex = (n) => {
    const val = Math.round(n * 255);
    return val.toString(16).padStart(2, "0");
  };
  return `#${toHex(rgb.red)}${toHex(rgb.green)}${toHex(rgb.blue)}`;
}

function hexToHsb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const s = max === 0 ? 0 : d / max;
  return { hue: h * 360, saturation: s, brightness: max };
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  CanvasEditor Component                                                    */
/* ═══════════════════════════════════════════════════════════════════════════ */
export function CanvasEditor({ imageUrl, onSave, onClose }) {
  const canvasRef = useRef(null);
  const fabricRef = useRef(null);
  const bgImageRef = useRef(null);

  // Layer state
  const [layers, setLayers] = useState([]);
  const [activeLayerId, setActiveLayerId] = useState(null);

  // Text controls
  const [textContent, setTextContent] = useState("Your text");
  const [selectedFont, setSelectedFont] = useState("Roboto");
  const [fontSize, setFontSize] = useState(48);
  const [fontColor, setFontColor] = useState({ hue: 0, saturation: 0, brightness: 0 });
  const [fontBold, setFontBold] = useState(false);
  const [fontItalic, setFontItalic] = useState(false);
  const [textStroke, setTextStroke] = useState(false);
  const [strokeColor, setStrokeColor] = useState({ hue: 0, saturation: 0, brightness: 1 });
  const [rotation, setRotation] = useState(0);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showStrokeColorPicker, setShowStrokeColorPicker] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);

  /* ── Sync layers from canvas ───────────────────────────────────────────── */
  const syncLayers = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const objects = canvas.getObjects();
    const layerList = objects
      .filter((obj) => obj !== bgImageRef.current)
      .map((obj, idx) => ({
        id: obj._layerId || `layer-${idx}`,
        name: obj._layerName || (obj.type === "textbox" ? obj.text?.slice(0, 20) || "Text" : `Layer ${idx + 1}`),
        type: obj.type,
        visible: obj.visible !== false,
        object: obj,
      }));
    setLayers(layerList);
  }, []);

  /* ── Initialize canvas ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = new fabric.Canvas(canvasRef.current, {
      width: 800,
      height: 800,
      backgroundColor: "#ffffff",
      selection: true,
      preserveObjectStacking: true,
    });
    fabricRef.current = canvas;

    // Load background image
    if (imageUrl) {
      console.log("[CanvasEditor] Loading background image:", imageUrl);

      // Strategy: fetch the image as a blob, convert to a data URL,
      // then load into Fabric. This avoids all CORS/crossOrigin issues
      // when running inside a Shopify iframe.
      const loadViaFetch = async () => {
        try {
          const resp = await fetch(imageUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          console.log("[CanvasEditor] Image fetched as data URL, size:", (dataUrl.length / 1024).toFixed(1), "KB");
          return dataUrl;
        } catch (err) {
          console.warn("[CanvasEditor] Fetch failed, trying direct:", err.message);
          return null;
        }
      };

      const addImageToCanvas = (img) => {
        if (!img || !img.width || !img.height) {
          console.error("[CanvasEditor] Image has no dimensions");
          setCanvasReady(true);
          return;
        }
        console.log("[CanvasEditor] Image loaded:", img.width, "x", img.height);
        const scale = Math.min(800 / img.width, 800 / img.height);
        img.scaleX = scale;
        img.scaleY = scale;
        img.left = (800 - img.width * scale) / 2;
        img.top = (800 - img.height * scale) / 2;
        img.selectable = false;
        img.evented = false;
        img.hoverCursor = "default";
        img._isBackground = true;
        bgImageRef.current = img;
        // Fabric.js v7: insertAt(index, ...objects)
        canvas.insertAt(0, img);
        canvas.renderAll();
        setCanvasReady(true);
      };

      loadViaFetch().then((dataUrl) => {
        const urlToLoad = dataUrl || imageUrl;
        // Try FabricImage.fromURL first
        return fabric.FabricImage.fromURL(urlToLoad).then(addImageToCanvas);
      }).catch((err) => {
        console.warn("[CanvasEditor] FabricImage.fromURL failed:", err.message);
        // Final fallback: load via HTML Image element (no crossOrigin)
        const htmlImg = new window.Image();
        htmlImg.onload = () => {
          console.log("[CanvasEditor] Fallback HTML Image loaded:", htmlImg.naturalWidth, "x", htmlImg.naturalHeight);
          const fImg = new fabric.FabricImage(htmlImg);
          addImageToCanvas(fImg);
        };
        htmlImg.onerror = (e) => {
          console.error("[CanvasEditor] All image loading methods failed");
          setCanvasReady(true);
        };
        // Don't set crossOrigin — avoids CORS issues for same-origin images
        htmlImg.src = imageUrl;
      });
    } else {
      console.log("[CanvasEditor] No imageUrl provided");
      setCanvasReady(true);
    }

    // Event listeners
    canvas.on("selection:created", (e) => {
      const obj = e.selected?.[0];
      if (obj && obj._layerId) {
        setActiveLayerId(obj._layerId);
        updateControlsFromObject(obj);
      }
    });
    canvas.on("selection:updated", (e) => {
      const obj = e.selected?.[0];
      if (obj && obj._layerId) {
        setActiveLayerId(obj._layerId);
        updateControlsFromObject(obj);
      }
    });
    canvas.on("selection:cleared", () => {
      setActiveLayerId(null);
    });
    canvas.on("object:modified", () => syncLayers());
    canvas.on("text:changed", () => syncLayers());

    return () => {
      canvas.dispose();
      fabricRef.current = null;
    };
  }, [imageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Update controls when an object is selected ────────────────────────── */
  const updateControlsFromObject = useCallback((obj) => {
    if (obj.type === "textbox") {
      setTextContent(obj.text || "");
      setSelectedFont(obj.fontFamily || "Roboto");
      setFontSize(Math.round(obj.fontSize || 48));
      setFontBold(obj.fontWeight === "bold");
      setFontItalic(obj.fontStyle === "italic");
      setRotation(Math.round(obj.angle || 0));
      try {
        const fill = obj.fill || "#000000";
        setFontColor(hexToHsb(fill));
      } catch {
        setFontColor({ hue: 0, saturation: 0, brightness: 0 });
      }
      if (obj.stroke && obj.strokeWidth > 0) {
        setTextStroke(true);
        try {
          setStrokeColor(hexToHsb(obj.stroke));
        } catch {
          setStrokeColor({ hue: 0, saturation: 0, brightness: 1 });
        }
      } else {
        setTextStroke(false);
      }
    }
  }, []);

  /* ── Get active text object ────────────────────────────────────────────── */
  const getActiveTextObject = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return null;
    const active = canvas.getActiveObject();
    if (active && active.type === "textbox") return active;
    // Fallback: find by activeLayerId
    if (activeLayerId) {
      const obj = canvas.getObjects().find((o) => o._layerId === activeLayerId);
      if (obj && obj.type === "textbox") return obj;
    }
    return null;
  }, [activeLayerId]);

  /* ── Add text layer ────────────────────────────────────────────────────── */
  const handleAddText = useCallback(async () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    await loadGoogleFont(selectedFont);

    const id = `text-${Date.now()}`;
    const text = new fabric.Textbox(textContent || "Your text", {
      left: 100 + Math.random() * 200,
      top: 100 + Math.random() * 200,
      fontFamily: selectedFont,
      fontSize: fontSize,
      fill: hsbToHex(fontColor),
      fontWeight: fontBold ? "bold" : "normal",
      fontStyle: fontItalic ? "italic" : "normal",
      stroke: textStroke ? hsbToHex(strokeColor) : null,
      strokeWidth: textStroke ? 2 : 0,
      angle: rotation,
      width: 350,
      textAlign: "center",
      editable: true,
      cornerStyle: "circle",
      cornerColor: "#2c6ecb",
      borderColor: "#2c6ecb",
      transparentCorners: false,
      padding: 8,
    });
    text._layerId = id;
    text._layerName = (textContent || "Your text").slice(0, 20);

    canvas.add(text);
    canvas.setActiveObject(text);
    canvas.renderAll();
    setActiveLayerId(id);
    syncLayers();
  }, [textContent, selectedFont, fontSize, fontColor, fontBold, fontItalic, textStroke, strokeColor, rotation, syncLayers]);

  /* ── Update active text properties ─────────────────────────────────────── */
  const applyToActive = useCallback((props) => {
    const obj = getActiveTextObject();
    if (!obj) return;
    obj.set(props);
    fabricRef.current?.renderAll();
    syncLayers();
  }, [getActiveTextObject, syncLayers]);

  const handleFontChange = useCallback(async (val) => {
    setSelectedFont(val);
    await loadGoogleFont(val);
    applyToActive({ fontFamily: val });
  }, [applyToActive]);

  const handleFontSizeChange = useCallback((val) => {
    const size = Number(val);
    setFontSize(size);
    applyToActive({ fontSize: size });
  }, [applyToActive]);

  const handleColorChange = useCallback((val) => {
    setFontColor(val);
    applyToActive({ fill: hsbToHex(val) });
  }, [applyToActive]);

  const handleStrokeColorChange = useCallback((val) => {
    setStrokeColor(val);
    if (textStroke) {
      applyToActive({ stroke: hsbToHex(val) });
    }
  }, [applyToActive, textStroke]);

  const handleBoldToggle = useCallback(() => {
    const next = !fontBold;
    setFontBold(next);
    applyToActive({ fontWeight: next ? "bold" : "normal" });
  }, [fontBold, applyToActive]);

  const handleItalicToggle = useCallback(() => {
    const next = !fontItalic;
    setFontItalic(next);
    applyToActive({ fontStyle: next ? "italic" : "normal" });
  }, [fontItalic, applyToActive]);

  const handleStrokeToggle = useCallback(() => {
    const next = !textStroke;
    setTextStroke(next);
    applyToActive({
      stroke: next ? hsbToHex(strokeColor) : null,
      strokeWidth: next ? 2 : 0,
    });
  }, [textStroke, strokeColor, applyToActive]);

  const handleRotationChange = useCallback((val) => {
    const angle = Number(val);
    setRotation(angle);
    applyToActive({ angle });
  }, [applyToActive]);

  const handleTextContentChange = useCallback((val) => {
    setTextContent(val);
    applyToActive({ text: val });
    // Update layer name
    const obj = getActiveTextObject();
    if (obj) {
      obj._layerName = val.slice(0, 20);
      syncLayers();
    }
  }, [applyToActive, getActiveTextObject, syncLayers]);

  /* ── Layer actions ─────────────────────────────────────────────────────── */
  const handleToggleVisibility = useCallback((layerId) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const obj = canvas.getObjects().find((o) => o._layerId === layerId);
    if (obj) {
      obj.visible = !obj.visible;
      canvas.renderAll();
      syncLayers();
    }
  }, [syncLayers]);

  const handleDeleteLayer = useCallback((layerId) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const obj = canvas.getObjects().find((o) => o._layerId === layerId);
    if (obj) {
      canvas.remove(obj);
      canvas.renderAll();
      if (activeLayerId === layerId) setActiveLayerId(null);
      syncLayers();
    }
  }, [activeLayerId, syncLayers]);

  const handleSelectLayer = useCallback((layerId) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const obj = canvas.getObjects().find((o) => o._layerId === layerId);
    if (obj) {
      canvas.setActiveObject(obj);
      canvas.renderAll();
      setActiveLayerId(layerId);
      updateControlsFromObject(obj);
    }
  }, [updateControlsFromObject]);

  const handleMoveLayer = useCallback((layerId, direction) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const obj = canvas.getObjects().find((o) => o._layerId === layerId);
    if (!obj) return;
    if (direction === "up") {
      canvas.bringObjectForward(obj);
    } else {
      // Prevent moving below background
      const idx = canvas.getObjects().indexOf(obj);
      if (idx > 1) {
        canvas.sendObjectBackwards(obj);
      }
    }
    canvas.renderAll();
    syncLayers();
  }, [syncLayers]);

  /* ── Save canvas ───────────────────────────────────────────────────────── */
  const handleSave = useCallback(async () => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    setIsSaving(true);
    try {
      // Deselect to remove selection handles from export
      canvas.discardActiveObject();
      canvas.renderAll();

      const dataUrl = canvas.toDataURL({
        format: "png",
        quality: 1,
        multiplier: 1,
      });

      if (onSave) {
        await onSave(dataUrl);
      }
    } catch (err) {
      console.error("Failed to save canvas:", err);
      alert("Failed to save image. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [onSave]);

  /* ── Render ────────────────────────────────────────────────────────────── */
  const colorHex = hsbToHex(fontColor);
  const strokeHex = hsbToHex(strokeColor);

  return (
    <div style={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <Text variant="headingLg" as="h2">Design Editor</Text>
          <InlineStack gap="200">
            <Button onClick={onClose} variant="plain">Cancel</Button>
            <Button variant="primary" onClick={handleSave} loading={isSaving} disabled={!canvasReady}>
              Save & Apply
            </Button>
          </InlineStack>
        </div>

        <div style={styles.body}>
          {/* Left Panel — Layers */}
          <div style={styles.leftPanel}>
            <div style={styles.panelHeader}>
              <Text variant="headingSm" as="h3">Layers</Text>
            </div>
            <div style={styles.layerList}>
              {layers.length === 0 && (
                <div style={styles.emptyLayers}>
                  <Text variant="bodySm" tone="subdued">No text layers yet. Add one from the toolbar.</Text>
                </div>
              )}
              {layers.map((layer) => (
                <div
                  key={layer.id}
                  style={{
                    ...styles.layerItem,
                    background: activeLayerId === layer.id ? "#e8f5ff" : "#fff",
                    borderColor: activeLayerId === layer.id ? "#2c6ecb" : "#e1e3e5",
                  }}
                  onClick={() => handleSelectLayer(layer.id)}
                >
                  <div style={styles.layerInfo}>
                    <Badge tone={layer.visible ? "info" : undefined} size="small">T</Badge>
                    <Text variant="bodySm" as="span" truncate>
                      {layer.name || "Text layer"}
                    </Text>
                  </div>
                  <div style={styles.layerActions}>
                    <button
                      style={styles.iconBtn}
                      onClick={(e) => { e.stopPropagation(); handleMoveLayer(layer.id, "up"); }}
                      title="Move up"
                    >▲</button>
                    <button
                      style={styles.iconBtn}
                      onClick={(e) => { e.stopPropagation(); handleMoveLayer(layer.id, "down"); }}
                      title="Move down"
                    >▼</button>
                    <button
                      style={styles.iconBtn}
                      onClick={(e) => { e.stopPropagation(); handleToggleVisibility(layer.id); }}
                      title={layer.visible ? "Hide" : "Show"}
                    >{layer.visible ? "👁" : "👁‍🗨"}</button>
                    <button
                      style={{ ...styles.iconBtn, color: "#d72c0d" }}
                      onClick={(e) => { e.stopPropagation(); handleDeleteLayer(layer.id); }}
                      title="Delete"
                    >✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Center — Canvas */}
          <div style={styles.canvasContainer}>
            {!canvasReady && (
              <div style={styles.canvasLoading}>
                <Spinner size="large" />
                <Text variant="bodySm" tone="subdued">Loading image...</Text>
              </div>
            )}
            <canvas ref={canvasRef} style={{
              display: canvasReady ? "block" : "none",
              maxWidth: "100%",
              maxHeight: "calc(95vh - 120px)",
              objectFit: "contain",
            }} />
          </div>

          {/* Right Panel — Properties */}
          <div style={styles.rightPanel}>
            <div style={styles.panelHeader}>
              <Text variant="headingSm" as="h3">Text Properties</Text>
            </div>
            <div style={styles.propsContent}>
              <BlockStack gap="300">
                {/* Text input */}
                <TextField
                  label="Text"
                  value={textContent}
                  onChange={handleTextContentChange}
                  multiline={2}
                  autoComplete="off"
                />

                {/* Font family */}
                <Select
                  label="Font"
                  options={FONT_OPTIONS}
                  value={selectedFont}
                  onChange={handleFontChange}
                />

                {/* Font size */}
                <TextField
                  label="Size"
                  type="number"
                  value={String(fontSize)}
                  onChange={handleFontSizeChange}
                  min={8}
                  max={300}
                  suffix="px"
                  autoComplete="off"
                />

                {/* Bold / Italic / Stroke */}
                <div>
                  <Text variant="bodySm" as="p" fontWeight="semibold">Style</Text>
                  <InlineStack gap="200" blockAlign="center">
                    <button
                      onClick={handleBoldToggle}
                      style={{
                        ...styles.styleBtn,
                        fontWeight: "bold",
                        background: fontBold ? "#2c6ecb" : "#f6f6f7",
                        color: fontBold ? "#fff" : "#333",
                      }}
                      title="Bold"
                    >B</button>
                    <button
                      onClick={handleItalicToggle}
                      style={{
                        ...styles.styleBtn,
                        fontStyle: "italic",
                        background: fontItalic ? "#2c6ecb" : "#f6f6f7",
                        color: fontItalic ? "#fff" : "#333",
                      }}
                      title="Italic"
                    >I</button>
                    <button
                      onClick={handleStrokeToggle}
                      style={{
                        ...styles.styleBtn,
                        textDecoration: "underline",
                        background: textStroke ? "#2c6ecb" : "#f6f6f7",
                        color: textStroke ? "#fff" : "#333",
                      }}
                      title="Text outline/stroke"
                    >S</button>
                  </InlineStack>
                </div>

                {/* Color */}
                <div>
                  <Text variant="bodySm" as="p" fontWeight="semibold">Text Colour</Text>
                  <div style={{ marginTop: 4 }}>
                    <button
                      onClick={() => setShowColorPicker(!showColorPicker)}
                      style={{
                        ...styles.colorSwatch,
                        backgroundColor: colorHex,
                      }}
                      title="Pick text colour"
                    />
                    <span style={{ marginLeft: 8, fontSize: 12, color: "#666" }}>{colorHex}</span>
                  </div>
                  {showColorPicker && (
                    <div style={styles.colorPickerWrap}>
                      <ColorPicker
                        color={fontColor}
                        onChange={handleColorChange}
                      />
                    </div>
                  )}
                </div>

                {/* Stroke color */}
                {textStroke && (
                  <div>
                    <Text variant="bodySm" as="p" fontWeight="semibold">Stroke Colour</Text>
                    <div style={{ marginTop: 4 }}>
                      <button
                        onClick={() => setShowStrokeColorPicker(!showStrokeColorPicker)}
                        style={{
                          ...styles.colorSwatch,
                          backgroundColor: strokeHex,
                        }}
                        title="Pick stroke colour"
                      />
                      <span style={{ marginLeft: 8, fontSize: 12, color: "#666" }}>{strokeHex}</span>
                    </div>
                    {showStrokeColorPicker && (
                      <div style={styles.colorPickerWrap}>
                        <ColorPicker
                          color={strokeColor}
                          onChange={handleStrokeColorChange}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Rotation */}
                <div>
                  <Text variant="bodySm" as="p" fontWeight="semibold">Rotation</Text>
                  <InlineStack gap="200" blockAlign="center">
                    <input
                      type="range"
                      min={0}
                      max={360}
                      value={rotation}
                      onChange={(e) => handleRotationChange(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontSize: 12, minWidth: 36, textAlign: "right" }}>{rotation}°</span>
                  </InlineStack>
                </div>

                {/* Add text button */}
                <div style={{ borderTop: "1px solid #e1e3e5", paddingTop: 12 }}>
                  <Button onClick={handleAddText} fullWidth variant="primary" icon={PlusIcon}>
                    Add Text Layer
                  </Button>
                </div>
              </BlockStack>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Styles                                                                    */
/* ═══════════════════════════════════════════════════════════════════════════ */
const styles = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.65)",
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modal: {
    background: "#fff",
    borderRadius: 16,
    width: "100%",
    maxWidth: 1300,
    maxHeight: "95vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 24px 80px rgba(0,0,0,0.3)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 24px",
    borderBottom: "1px solid #e1e3e5",
    background: "#f9fafb",
  },
  body: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
    minHeight: 0,
  },
  leftPanel: {
    width: 220,
    borderRight: "1px solid #e1e3e5",
    display: "flex",
    flexDirection: "column",
    background: "#fafbfc",
  },
  panelHeader: {
    padding: "12px 16px",
    borderBottom: "1px solid #e1e3e5",
    background: "#f3f5f7",
  },
  layerList: {
    flex: 1,
    overflowY: "auto",
    padding: 8,
  },
  emptyLayers: {
    padding: 16,
    textAlign: "center",
  },
  layerItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 10px",
    border: "1px solid #e1e3e5",
    borderRadius: 8,
    marginBottom: 6,
    cursor: "pointer",
    transition: "background 0.12s ease",
  },
  layerInfo: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  layerActions: {
    display: "flex",
    gap: 2,
    flexShrink: 0,
  },
  iconBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    padding: "2px 4px",
    borderRadius: 4,
    lineHeight: 1,
    color: "#666",
  },
  canvasContainer: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    background: "#e8e8e8",
    overflow: "hidden",
    position: "relative",
    minWidth: 0,
    minHeight: 0,
  },
  canvasLoading: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
  },
  rightPanel: {
    width: 260,
    borderLeft: "1px solid #e1e3e5",
    display: "flex",
    flexDirection: "column",
    background: "#fafbfc",
  },
  propsContent: {
    flex: 1,
    overflowY: "auto",
    padding: 16,
  },
  styleBtn: {
    width: 36,
    height: 36,
    border: "1px solid #ccc",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 15,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all 0.12s ease",
  },
  colorSwatch: {
    width: 32,
    height: 32,
    border: "2px solid #ccc",
    borderRadius: 8,
    cursor: "pointer",
    display: "inline-block",
    verticalAlign: "middle",
  },
  colorPickerWrap: {
    marginTop: 8,
    padding: 8,
    background: "#fff",
    border: "1px solid #e1e3e5",
    borderRadius: 8,
    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
  },
};
