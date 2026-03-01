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

function getDaysUntilReset() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const diffMs = nextMonth - now;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
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
      apiFetch("/confirm", { method: "POST" })
        .then(() => loadBilling())
        .catch((err) => setError(err.message));
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
  const creditsUsed = billing?.usage?.credits || 0;
  const creditsLimit = billing?.limits?.creditsPerMonth || 25;
  const creditPct = Math.min(100, (creditsUsed / creditsLimit) * 100);
  const daysLeft = getDaysUntilReset();

  return (
    <BlockStack gap="400">
      {error && (
        <Banner tone="critical" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Banner>
      )}

      {/* Credits Usage Card */}
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

          {/* Credit usage meter */}
          <BlockStack gap="200">
            <InlineStack align="space-between">
              <Text variant="bodyMd" fontWeight="semibold">Credits Used</Text>
              <Text variant="bodyMd" fontWeight="semibold">
                {creditsUsed} / {creditsLimit}
              </Text>
            </InlineStack>
            <ProgressBar
              progress={creditPct}
              tone={creditPct >= 90 ? "critical" : creditPct >= 70 ? "warning" : "primary"}
              size="small"
            />
            <Text variant="bodySm" tone="subdued">
              Every AI design generation uses 1 credit — even if you don't publish it.
            </Text>
          </BlockStack>

          <Divider />

          {/* Days until reset */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 16px",
              background: "#f6f6f7",
              borderRadius: 8,
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 8,
                background: isPro ? "#1a73e8" : "#5c6ac4",
                color: "#fff",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span style={{ fontSize: 18, fontWeight: 700, lineHeight: 1 }}>{daysLeft}</span>
              <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>days</span>
            </div>
            <div>
              <Text variant="bodyMd" fontWeight="semibold">
                Credits reset in {daysLeft} day{daysLeft !== 1 ? "s" : ""}
              </Text>
              <Text variant="bodySm" tone="subdued">
                On the 1st of each month your credits are refreshed to {creditsLimit}.
              </Text>
            </div>
          </div>

          {/* Remaining credits callout */}
          {creditsUsed >= creditsLimit ? (
            <Banner tone="critical">
              <p>
                You've used all your credits this month.{" "}
                {!isPro
                  ? "Upgrade to Pro for 150 credits/month."
                  : `Your credits reset in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}.`}
              </p>
            </Banner>
          ) : creditsUsed >= creditsLimit * 0.8 ? (
            <Banner tone="warning">
              <p>
                You have {creditsLimit - creditsUsed} credit{creditsLimit - creditsUsed !== 1 ? "s" : ""} remaining this month.
                {!isPro && " Consider upgrading to Pro for 150 credits/month."}
              </p>
            </Banner>
          ) : null}
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
              <Text variant="bodyMd">✓ 25 AI credits per month</Text>
              <Text variant="bodyMd">✓ Canvas design editor</Text>
              <Text variant="bodyMd">✓ AI mockup generation</Text>
              <Text variant="bodyMd">✓ Printful integration</Text>
              <Text variant="bodyMd">✓ Unlimited publishes</Text>
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
              <Text variant="bodyMd" fontWeight="bold">✓ 150 AI credits per month</Text>
              <Text variant="bodyMd">✓ Canvas design editor</Text>
              <Text variant="bodyMd">✓ AI mockup generation</Text>
              <Text variant="bodyMd">✓ Printful integration</Text>
              <Text variant="bodyMd">✓ Unlimited publishes</Text>
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

      {/* What uses credits? */}
      <Card>
        <BlockStack gap="300">
          <Text variant="headingSm" as="h3">What uses credits?</Text>
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="attention">1 credit</Badge>
              <Text variant="bodyMd">Each AI design generation (even if you don't publish)</Text>
            </InlineStack>
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="success">Free</Badge>
              <Text variant="bodyMd">Publishing products to your Shopify store</Text>
            </InlineStack>
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="success">Free</Badge>
              <Text variant="bodyMd">Canvas editor edits & downloads</Text>
            </InlineStack>
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="success">Free</Badge>
              <Text variant="bodyMd">Browsing your design library</Text>
            </InlineStack>
          </BlockStack>
        </BlockStack>
      </Card>

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
                <Text variant="bodyMd">• 25 credits per month (instead of 150)</Text>
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
