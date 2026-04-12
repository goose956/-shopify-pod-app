import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Text,
  Banner,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  Spinner,
  Divider,
} from "@shopify/polaris";
import { getSessionToken } from "../utils/sessionToken";

const ACTION_LABELS = {
  "analyze-image": "Image Analysis",
  "design-preview": "Design Preview",
  "mockup-custom": "Custom Mockup",
  "mockup-printful": "Printful Mockup",
  "mockup-ai": "AI Mockup",
  "revise-design": "Design Revision",
  "finalize-product-image": "Product Image",
  "finalize-publish": "Shopify Publish",
  "finalize-product": "Finalize Product",
  "generate-mockup": "Generate Mockup",
};

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function UsageLog() {
  const [logData, setLogData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadLog = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const token = await getSessionToken();
      const res = await fetch("/api/billing/usage-log", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLogData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadLog(); }, [loadLog]);

  if (loading) {
    return (
      <Card>
        <div style={{ padding: 40, textAlign: "center" }}>
          <Spinner size="large" />
          <div style={{ marginTop: 12 }}>
            <Text tone="subdued">Loading usage log...</Text>
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <Banner title="Failed to load usage log" tone="critical">
          <p>{error}</p>
        </Banner>
      </Card>
    );
  }

  const log = logData?.log || [];
  const credits = logData?.usage?.credits || 0;
  const limit = logData?.limits?.effectiveLimit || 0;
  const remaining = Math.max(0, limit - credits);
  const creditEntries = log.filter((e) => e.type === "credit");
  const errorEntries = log.filter((e) => e.type === "error");

  return (
    <BlockStack gap="400">
      {/* Summary bar */}
      <Card>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <Text variant="headingMd" as="h2">Usage Log</Text>
            <Text variant="bodySm" tone="subdued">Credit usage and error history for this billing period</Text>
          </div>
          <InlineStack gap="300">
            <div style={{
              background: "#eef6ff", border: "1px solid #6dabf5", borderRadius: 8,
              padding: "8px 16px", textAlign: "center",
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#1a73e8" }}>{credits}</div>
              <div style={{ fontSize: 11, color: "#555" }}>Used</div>
            </div>
            <div style={{
              background: "#f0faf0", border: "1px solid #6bc96b", borderRadius: 8,
              padding: "8px 16px", textAlign: "center",
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#2e7d32" }}>{remaining}</div>
              <div style={{ fontSize: 11, color: "#555" }}>Remaining</div>
            </div>
            <div style={{
              background: "#f6f6f7", border: "1px solid #ccc", borderRadius: 8,
              padding: "8px 16px", textAlign: "center",
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#333" }}>{limit}</div>
              <div style={{ fontSize: 11, color: "#555" }}>Limit</div>
            </div>
            <Button onClick={loadLog} size="slim">Refresh</Button>
          </InlineStack>
        </div>
      </Card>

      {/* Errors section */}
      {errorEntries.length > 0 && (
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h3">
                Errors
              </Text>
              <Badge tone="critical">{errorEntries.length}</Badge>
            </InlineStack>
            <Divider />
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {errorEntries.map((entry, i) => (
                <div
                  key={`err-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    padding: "10px 0",
                    borderBottom: i < errorEntries.length - 1 ? "1px solid #f0f0f0" : "none",
                  }}
                >
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: "#e53935", marginTop: 6, flexShrink: 0,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <Badge tone="critical">{ACTION_LABELS[entry.action] || entry.action}</Badge>
                      <Text variant="bodySm" tone="subdued">{formatTime(entry.ts)}</Text>
                    </div>
                    <div style={{
                      marginTop: 4, fontSize: 13, color: "#b71c1c",
                      background: "#fef0f0", padding: "6px 10px", borderRadius: 6,
                      wordBreak: "break-word",
                    }}>
                      {entry.error}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </BlockStack>
        </Card>
      )}

      {/* Credit usage log */}
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text variant="headingMd" as="h3">
              Credit Activity
            </Text>
            <Badge>{creditEntries.length} entries</Badge>
          </InlineStack>
          <Divider />
          {log.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center" }}>
              <Text tone="subdued">No usage recorded yet this billing period.</Text>
            </div>
          ) : (
            <div style={{ maxHeight: 500, overflowY: "auto" }}>
              {log.map((entry, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 0",
                    borderBottom: i < log.length - 1 ? "1px solid #f0f0f0" : "none",
                  }}
                >
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: entry.type === "error" ? "#e53935" : "#4caf50",
                    flexShrink: 0,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Badge tone={entry.type === "error" ? "critical" : "info"}>
                        {ACTION_LABELS[entry.action] || entry.action}
                      </Badge>
                      {entry.type === "credit" && (
                        <Text variant="bodySm" fontWeight="semibold">−1 credit</Text>
                      )}
                      {entry.type === "error" && (
                        <Text variant="bodySm" tone="critical" truncate>{entry.error}</Text>
                      )}
                    </InlineStack>
                  </div>
                  <div style={{ flexShrink: 0 }}>
                    <Text variant="bodySm" tone="subdued">{formatTime(entry.ts)}</Text>
                  </div>
                  {entry.type === "credit" && entry.total && (
                    <div style={{
                      flexShrink: 0, fontSize: 11, color: "#888",
                      background: "#f6f6f7", borderRadius: 4, padding: "2px 6px",
                    }}>
                      {entry.total}/{limit}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
