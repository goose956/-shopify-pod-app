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

function DesignCard({ design, onDelete }) {
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

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

  const handleDownload = () => {
    if (!design.previewImageUrl) return;
    const a = document.createElement("a");
    a.href = design.previewImageUrl;
    a.download = `design-${design.id}.png`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
            <Button size="slim" onClick={handleDownload}>
              Download
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
        headers: { "X-Shopify-Session-Token": sessionToken },
      });
      if (!res.ok) throw new Error("Failed to load designs");
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
        headers: { "X-Shopify-Session-Token": sessionToken },
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
