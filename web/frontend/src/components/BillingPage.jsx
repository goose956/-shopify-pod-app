import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Text,
  Button,
  Banner,
  BlockStack,
  InlineStack,
  Badge,
  ProgressBar,
  Divider,
  Box,
  Modal,
  Spinner,
} from "@shopify/polaris";
import { getSessionToken } from "../utils/sessionToken";

const API_BASE = "/api/billing";

async function apiFetch(path, options = {}) {
  const token = await getSessionToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function BillingPage() {
  const [billing, setBilling] = useState(null);
  const [plans, setPlans] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showCancelModal, setShowCancelModal] = useState(false);

  const loadBilling = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [statusData, plansData] = await Promise.all([
        apiFetch("/status"),
        apiFetch("/plans"),
      ]);
      setBilling(statusData);
      setPlans(plansData.plans);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBilling();

    // Check if returning from Shopify billing confirmation
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing_confirmed") === "true") {
      // Confirm the subscription
      apiFetch("/confirm", { method: "POST" })
        .then(() => loadBilling())
        .catch((err) => setError(err.message));
      // Clean URL
      const url = new URL(window.location);
      url.searchParams.delete("billing_confirmed");
      url.searchParams.delete("plan");
      url.searchParams.delete("charge_id");
      window.history.replaceState({}, "", url.toString());
    }
  }, [loadBilling]);

  const handleUpgrade = useCallback(async () => {
    try {
      setActionLoading(true);
      setError(null);
      const data = await apiFetch("/subscribe", {
        method: "POST",
        body: JSON.stringify({ plan: "pro" }),
      });
      if (data.confirmationUrl) {
        // Redirect to Shopify's billing approval page
        window.top.location.href = data.confirmationUrl;
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      setActionLoading(true);
      setError(null);
      setShowCancelModal(false);
      await apiFetch("/cancel", { method: "POST" });
      await loadBilling();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }, [loadBilling]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
        <Spinner size="large" />
      </div>
    );
  }

  const isPro = billing?.plan === "pro";
  const designPct = billing ? Math.min(100, (billing.usage.designs / billing.limits.designsPerMonth) * 100) : 0;
  const publishPct = billing ? Math.min(100, (billing.usage.publishes / billing.limits.publishesPerMonth) * 100) : 0;

  return (
    <BlockStack gap="400">
      {error && (
        <Banner tone="critical" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Banner>
      )}

      {/* Current Plan Card */}
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <InlineStack gap="200" blockAlign="center">
              <Text variant="headingLg" as="h2">Your Plan</Text>
              <Badge tone={isPro ? "success" : "info"} size="large">
                {isPro ? "Pro" : "Free"}
              </Badge>
            </InlineStack>
            {isPro && (
              <Text variant="bodyMd" tone="subdued">
                ${billing?.price}/month
              </Text>
            )}
          </InlineStack>

          <Divider />

          {/* Usage meters */}
          <BlockStack gap="300">
            <div>
              <InlineStack align="space-between">
                <Text variant="bodyMd" fontWeight="semibold">Designs this month</Text>
                <Text variant="bodyMd">
                  {billing?.usage.designs} / {billing?.limits.designsPerMonth}
                </Text>
              </InlineStack>
              <div style={{ marginTop: 6 }}>
                <ProgressBar
                  progress={designPct}
                  tone={designPct >= 90 ? "critical" : designPct >= 70 ? "warning" : "primary"}
                  size="small"
                />
              </div>
            </div>

            <div>
              <InlineStack align="space-between">
                <Text variant="bodyMd" fontWeight="semibold">Publishes this month</Text>
                <Text variant="bodyMd">
                  {billing?.usage.publishes} / {billing?.limits.publishesPerMonth}
                </Text>
              </InlineStack>
              <div style={{ marginTop: 6 }}>
                <ProgressBar
                  progress={publishPct}
                  tone={publishPct >= 90 ? "critical" : publishPct >= 70 ? "warning" : "primary"}
                  size="small"
                />
              </div>
            </div>
          </BlockStack>
        </BlockStack>
      </Card>

      {/* Plan Comparison */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Free Plan Card */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h3">Free</Text>
              {!isPro && <Badge tone="info">Current</Badge>}
            </InlineStack>
            <Text variant="headingXl" as="p">$0</Text>
            <Text variant="bodySm" tone="subdued">Forever free</Text>
            <Divider />
            <BlockStack gap="200">
              <Text variant="bodyMd">✓ 5 AI designs per month</Text>
              <Text variant="bodyMd">✓ 5 Shopify publishes per month</Text>
              <Text variant="bodyMd">✓ Canvas design editor</Text>
              <Text variant="bodyMd">✓ AI mockup generation</Text>
              <Text variant="bodyMd">✓ Printful integration</Text>
            </BlockStack>
            {isPro && (
              <Button onClick={() => setShowCancelModal(true)} variant="plain" tone="critical">
                Downgrade to Free
              </Button>
            )}
          </BlockStack>
        </Card>

        {/* Pro Plan Card */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h3">Pro</Text>
              {isPro && <Badge tone="success">Current</Badge>}
            </InlineStack>
            <InlineStack gap="100" blockAlign="baseline">
              <Text variant="headingXl" as="p">$19.99</Text>
              <Text variant="bodyMd" tone="subdued">/month</Text>
            </InlineStack>
            <Text variant="bodySm" tone="subdued">7-day free trial</Text>
            <Divider />
            <BlockStack gap="200">
              <Text variant="bodyMd" fontWeight="bold">✓ 30 AI designs per month</Text>
              <Text variant="bodyMd" fontWeight="bold">✓ 30 Shopify publishes per month</Text>
              <Text variant="bodyMd">✓ Canvas design editor</Text>
              <Text variant="bodyMd">✓ AI mockup generation</Text>
              <Text variant="bodyMd">✓ Printful integration</Text>
            </BlockStack>
            {!isPro && (
              <Button
                onClick={handleUpgrade}
                variant="primary"
                loading={actionLoading}
                fullWidth
              >
                Start 7-Day Free Trial
              </Button>
            )}
            {isPro && (
              <Button onClick={() => setShowCancelModal(true)} variant="plain" tone="critical">
                Cancel Subscription
              </Button>
            )}
          </BlockStack>
        </Card>
      </div>

      {/* Subscription Details (Pro only) */}
      {isPro && billing?.subscriptionId && (
        <Card>
          <BlockStack gap="200">
            <Text variant="headingSm" as="h3">Subscription Details</Text>
            <InlineStack gap="400">
              <Text variant="bodyMd" tone="subdued">
                Status: <Badge tone="success">{billing.subscriptionStatus || "Active"}</Badge>
              </Text>
              {billing.trialEndsAt && (
                <Text variant="bodyMd" tone="subdued">
                  Trial ends: {new Date(billing.trialEndsAt).toLocaleDateString()}
                </Text>
              )}
            </InlineStack>
            <Text variant="bodySm" tone="subdued">
              Billing is managed through Shopify. You can also manage your subscription from{" "}
              <a href="https://admin.shopify.com/settings/billing" target="_top" rel="noopener">
                Shopify Settings → Billing
              </a>.
            </Text>
          </BlockStack>
        </Card>
      )}

      {/* Cancel Modal */}
      {showCancelModal && (
        <Modal
          open={showCancelModal}
          onClose={() => setShowCancelModal(false)}
          title="Cancel Subscription?"
          primaryAction={{
            content: "Cancel Subscription",
            destructive: true,
            onAction: handleCancel,
            loading: actionLoading,
          }}
          secondaryActions={[
            {
              content: "Keep Subscription",
              onAction: () => setShowCancelModal(false),
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text variant="bodyMd">
                Are you sure you want to cancel your Pro subscription?
              </Text>
              <Text variant="bodyMd">
                You'll be downgraded to the Free plan with:
              </Text>
              <BlockStack gap="100">
                <Text variant="bodyMd">• 5 designs per month (instead of 30)</Text>
                <Text variant="bodyMd">• 5 publishes per month (instead of 30)</Text>
              </BlockStack>
              <Text variant="bodyMd" tone="subdued">
                Your existing designs and published products will not be affected.
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </BlockStack>
  );
}
