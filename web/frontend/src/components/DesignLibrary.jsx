import { useState, useEffect, useCallback } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  InlineStack,
  Link,
  Modal,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { getSessionToken } from "../utils/sessionToken";
import JSZip from "jszip";
import { saveAs } from "file-saver";

function DesignCard({ design, onDelete }) {
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const statusTone = {
    published: "success",
    draft: "info",
    preview: "attention",
  }[design.status] || "default";

  const statusLabel = {
    published: "Published",
    draft: "Draft",
    preview: "Preview",
  }[design.status] || design.status || "Unknown";

  const productTypeLabel = {
    tshirt: "T-shirt",
    mug: "Mug",
    poster: "Poster",
  }[design.productType] || design.productType;

  const dateStr = design.updatedAt
    ? new Date(design.updatedAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

  const handleDownload = async () => {
    setDownloading(true);
    try {
      // Fetch all assets for this design
      const sessionToken = await getSessionToken();
      const res = await fetch(`/api/designs/${design.id}/assets`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });

      let assets = [];
      if (res.ok) {
        const data = await res.json();
        assets = data.assets || [];
      }

      // Collect unique URLs to download (assets + previewImageUrl as fallback)
      const urlSet = new Map();
      for (const asset of assets) {
        if (asset.url && !urlSet.has(asset.url)) {
          const label = `${asset.type || "image"}-${asset.role || "unknown"}`;
          urlSet.set(asset.url, label);
        }
      }
      // Ensure the preview image is included even if not in assets
      if (design.previewImageUrl && !urlSet.has(design.previewImageUrl)) {
        urlSet.set(design.previewImageUrl, "preview");
      }

      // Single file — download directly without ZIP
      if (urlSet.size <= 1) {
        const url = urlSet.keys().next().value || design.previewImageUrl;
        if (url) {
          const a = document.createElement("a");
          a.href = url;
          a.download = `design-${design.id}.png`;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
        setDownloading(false);
        return;
      }

      // Multiple files — bundle into a ZIP
      const zip = new JSZip();
      const nameCount = {};

      for (const [url, label] of urlSet) {
        try {
          const imgRes = await fetch(url);
          if (!imgRes.ok) continue;
          const blob = await imgRes.blob();

          // Detect extension from content-type or URL
          const ct = imgRes.headers.get("content-type") || "";
          let ext = "png";
          if (ct.includes("jpeg") || ct.includes("jpg")) ext = "jpg";
          else if (ct.includes("webp")) ext = "webp";
          else if (url.match(/\.(jpe?g|png|webp)/i)) {
            ext = url.match(/\.(jpe?g|png|webp)/i)[1].replace("jpeg", "jpg");
          }

          // Build unique filename
          const baseName = label.replace(/[^a-zA-Z0-9_-]/g, "_");
          nameCount[baseName] = (nameCount[baseName] || 0) + 1;
          const suffix = nameCount[baseName] > 1 ? `-${nameCount[baseName]}` : "";
          const filename = `${baseName}${suffix}.${ext}`;

          zip.file(filename, blob);
        } catch (fetchErr) {
          console.warn(`[Download] Failed to fetch asset: ${url}`, fetchErr);
        }
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const promptSlug = (design.prompt || "design")
        .slice(0, 30)
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
      saveAs(zipBlob, `${promptSlug}-${design.id.slice(0, 8)}.zip`);
    } catch (err) {
      console.error("[Download] Error downloading assets:", err);
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    await onDelete(design.id);
    setDeleting(false);
    setConfirmOpen(false);
  };

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e1e3e5",
        borderRadius: 12,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        transition: "box-shadow 0.15s ease, transform 0.15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = "0 4px 14px rgba(0,0,0,0.08)";
        e.currentTarget.style.transform = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "none";
        e.currentTarget.style.transform = "none";
      }}
    >
      {/* Image */}
      <div
        style={{
          width: "100%",
          aspectRatio: "1",
          background: "#f6f6f7",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {design.previewImageUrl ? (
          <img
            src={design.previewImageUrl}
            alt={design.prompt}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={(e) => {
              e.target.style.display = "none";
              e.target.parentElement.innerHTML = '<span style="color:#8c9196;font-size:13px">Image unavailable</span>';
            }}
          />
        ) : (
          <Text variant="bodySm" tone="subdued" as="p">
            No preview
          </Text>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: 12, flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
        <InlineStack gap="200" blockAlign="center" wrap>
          <Badge tone={statusTone}>{statusLabel}</Badge>
          <Badge>{productTypeLabel}</Badge>
        </InlineStack>

        <Text variant="bodySm" as="p" truncate>
          {design.prompt || "Untitled design"}
        </Text>

        {dateStr && (
          <Text variant="bodySm" tone="subdued" as="p">
            {dateStr}
          </Text>
        )}

        {/* Actions */}
        <div style={{ marginTop: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {design.previewImageUrl && (
            <Button size="slim" onClick={handleDownload} loading={downloading}>
              Download All
            </Button>
          )}
          {design.adminUrl && (
            <Button size="slim" url={design.adminUrl} target="_blank">
              Shopify
            </Button>
          )}
          <Button
            size="slim"
            tone="critical"
            icon={DeleteIcon}
            onClick={() => setConfirmOpen(true)}
            loading={deleting}
          >
            Delete
          </Button>
        </div>
      </div>

      {/* Delete confirmation modal */}
      {confirmOpen && (
        <Modal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Delete design?"
          primaryAction={{
            content: "Delete",
            destructive: true,
            loading: deleting,
            onAction: handleDelete,
          }}
          secondaryActions={[{ content: "Cancel", onAction: () => setConfirmOpen(false) }]}
        >
          <Modal.Section>
            <Text as="p">
              This will permanently remove this design and its assets. This cannot be undone.
            </Text>
          </Modal.Section>
        </Modal>
      )}
    </div>
  );
}

export function DesignLibrary() {
  const [designs, setDesigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");

  const fetchDesigns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sessionToken = await getSessionToken();
      const res = await fetch("/api/designs", {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Failed to load designs (HTTP ${res.status})`);
      }
      const data = await res.json();
      // Sort newest first
      const sorted = (data.designs || []).sort(
        (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      setDesigns(sorted);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDesigns();
  }, [fetchDesigns]);

  const handleDelete = async (designId) => {
    try {
      const sessionToken = await getSessionToken();
      const res = await fetch(`/api/designs/${designId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!res.ok) throw new Error("Failed to delete design");
      setDesigns((prev) => prev.filter((d) => d.id !== designId));
    } catch (err) {
      setError(err.message);
    }
  };

  const filtered = search.trim()
    ? designs.filter(
        (d) =>
          (d.prompt || "").toLowerCase().includes(search.toLowerCase()) ||
          (d.productType || "").toLowerCase().includes(search.toLowerCase()) ||
          (d.status || "").toLowerCase().includes(search.toLowerCase())
      )
    : designs;

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="200">
          <Text variant="headingMd" as="h2" fontWeight="semibold">Design Library</Text>
          <Text variant="bodyMd" tone="subdued" as="p">
            Browse all your previously generated designs in one place. You can search by prompt, product type, or status.
            Click on any design to download the artwork, or delete designs you no longer need. Designs that have been published
            to your Shopify store are marked with a green "Published" badge.
          </Text>
        </BlockStack>
      </Card>
      {error && (
        <Banner tone="critical" title="Error" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Banner>
      )}

      <Card>
        <BlockStack gap="400">
          <InlineStack gap="300" blockAlign="center" align="space-between">
            <Text variant="headingMd" as="h2" fontWeight="semibold">
              Design Library
            </Text>
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="info">{designs.length} design{designs.length !== 1 ? "s" : ""}</Badge>
              <Button onClick={fetchDesigns} loading={loading} size="slim">
                Refresh
              </Button>
            </InlineStack>
          </InlineStack>

          <TextField
            value={search}
            onChange={setSearch}
            placeholder="Search by prompt, product type, or status..."
            clearButton
            onClearButtonClick={() => setSearch("")}
            autoComplete="off"
          />
        </BlockStack>
      </Card>

      {loading && designs.length === 0 ? (
        <Card>
          <BlockStack gap="300" inlineAlign="center">
            <Text variant="bodyMd" tone="subdued" as="p" alignment="center">
              Loading designs...
            </Text>
          </BlockStack>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            heading={search ? "No matching designs" : "No designs yet"}
            image=""
          >
            <p>
              {search
                ? "Try a different search term."
                : "Generate your first design in the Generator tab!"}
            </p>
          </EmptyState>
        </Card>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          {filtered.map((design) => (
            <DesignCard key={design.id} design={design} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </BlockStack>
  );
}
