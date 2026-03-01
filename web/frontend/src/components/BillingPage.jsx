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

/* ── Styled plan card ────────────────────────────────────────────────── */
function PlanCard({ name, price, priceLabel, subtitle, features, isCurrent, isPrimary, bestValue, buttonLabel, onAction, loading, downgradeLabel, onDowngrade }) {
  // Colour schemes per plan
  const schemes = {
    Free:  { bg: "#f0f4f8", border: "#c4cdd5", accent: "#5c6ac4", headerBg: "#e4e9f0" },
    Pro:   { bg: "#eef6ff", border: "#6dabf5", accent: "#1a73e8", headerBg: "#d4e6fc" },
    Gold:  { bg: "#fef9ec", border: "#e0b84d", accent: "#b8860b", headerBg: "#f5e8be" },
  };
  const s = schemes[name] || schemes.Free;

  return (
    <div
      style={{
        background: s.bg,
        border: `2px solid ${isCurrent ? s.accent : s.border}`,
        borderRadius: 14,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        boxShadow: isPrimary ? "0 4px 20px rgba(0,0,0,0.10)" : "0 1px 4px rgba(0,0,0,0.04)",
        transform: isPrimary ? "scale(1.02)" : "none",
        transition: "transform 0.15s, box-shadow 0.15s",
      }}
    >
      {/* Best value ribbon */}
      {bestValue && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: -30,
            background: "#b8860b",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            padding: "4px 36px",
            transform: "rotate(35deg)",
            letterSpacing: 0.5,
            zIndex: 2,
          }}
        >
          BEST VALUE
        </div>
      )}

      {/* Header */}
      <div style={{ background: s.headerBg, padding: "16px 20px 12px" }}>
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingMd" as="h3" fontWeight="bold">{name}</Text>
          {isCurrent && <Badge tone="success">Current Plan</Badge>}
        </InlineStack>
        <div style={{ marginTop: 6 }}>
          <InlineStack gap="100" blockAlign="baseline">
            <Text variant="headingXl" as="p" fontWeight="bold">{priceLabel}</Text>
            {price > 0 && <Text variant="bodyMd" tone="subdued">/month</Text>}
          </InlineStack>
          <Text variant="bodySm" tone="subdued">{subtitle}</Text>
        </div>
      </div>

      {/* Features */}
      <div style={{ padding: "16px 20px", flex: 1 }}>
        <BlockStack gap="200">
          {features.map((f, i) => (
            <Text key={i} variant="bodyMd" fontWeight={f.bold ? "bold" : "regular"}>
              {f.text}
            </Text>
          ))}
        </BlockStack>
      </div>

      {/* Action */}
      <div style={{ padding: "0 20px 16px" }}>
        {!isCurrent && buttonLabel && (
          <Button
            onClick={onAction}
            variant={isPrimary ? "primary" : "secondary"}
            loading={loading}
            fullWidth
            tone={isPrimary ? undefined : undefined}
          >
            {buttonLabel}
          </Button>
        )}
        {isCurrent && downgradeLabel && (
          <Button onClick={onDowngrade} variant="plain" tone="critical" fullWidth>
            {downgradeLabel}
          </Button>
        )}
        {isCurrent && !downgradeLabel && (
          <div style={{ textAlign: "center", padding: 4 }}>
            <Text variant="bodySm" tone="subdued">You're on this plan</Text>
          </div>
        )}
      </div>
    </div>
  );
}

export function BillingPage() {
  const [billing, setBilling] = useState(null);
  const [plans, setPlans] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null); // track which plan is loading
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

  const handleUpgrade = useCallback(async (planId) => {
    try {
      setActionLoading(planId);
      setError(null);
      const data = await apiFetch("/subscribe", {
        method: "POST",
        body: JSON.stringify({ plan: planId }),
      });
      if (data.confirmationUrl) {
        window.top.location.href = data.confirmationUrl;
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      setActionLoading("cancel");
      setError(null);
      setShowCancelModal(false);
      await apiFetch("/cancel", { method: "POST" });
      await loadBilling();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  }, [loadBilling]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
        <Spinner size="large" />
      </div>
    );
  }

  const currentPlan = billing?.plan || "free";
  const isPaid = currentPlan === "pro" || currentPlan === "gold";
  const creditsUsed = billing?.usage?.credits || 0;
  const creditsLimit = billing?.limits?.effectiveLimit || billing?.limits?.creditsPerMonth || 25;
  const fullCreditsLimit = billing?.limits?.creditsPerMonth || 25;
  const isOnTrial = billing?.isOnTrial || false;
  const trialCreditsLimit = billing?.trialCreditsLimit || null;
  const creditPct = Math.min(100, (creditsUsed / creditsLimit) * 100);
  const daysLeft = getDaysUntilReset();
  const creditsRemaining = Math.max(0, creditsLimit - creditsUsed);

  // Calculate days left in trial
  let trialDaysLeft = 0;
  if (isOnTrial && billing?.trialEndsAt) {
    trialDaysLeft = Math.max(0, Math.ceil((new Date(billing.trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)));
  }

  return (
    <BlockStack gap="400">
      {error && (
        <Banner tone="critical" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Banner>
      )}

      {/* ── Credits & Usage Card ─────────────────────────────────────── */}
      <div
        style={{
          background: "linear-gradient(135deg, #1e293b 0%, #334155 100%)",
          borderRadius: 14,
          padding: "24px 28px",
          color: "#fff",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
          {/* Left: plan + credits */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{ fontSize: 20, fontWeight: 700 }}>Your Plan</span>
              <span
                style={{
                  background: currentPlan === "gold" ? "#b8860b" : currentPlan === "pro" ? "#1a73e8" : "#5c6ac4",
                  padding: "3px 12px",
                  borderRadius: 20,
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {currentPlan === "gold" ? "Gold" : currentPlan === "pro" ? "Pro" : "Free"}
              </span>
            </div>

            <div style={{ marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 14, opacity: 0.85 }}>Credits Used</span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                {creditsUsed} / {creditsLimit}
              </span>
            </div>
            <div
              style={{
                height: 10,
                borderRadius: 5,
                background: "rgba(255,255,255,0.15)",
                overflow: "hidden",
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${creditPct}%`,
                  borderRadius: 5,
                  background:
                    creditPct >= 90
                      ? "#ef4444"
                      : creditPct >= 70
                      ? "#f59e0b"
                      : "#22c55e",
                  transition: "width 0.4s ease",
                }}
              />
            </div>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              Every AI design generation uses 1 credit — even if you don't publish.
            </span>            {isOnTrial && (
              <div
                style={{
                  marginTop: 10,
                  padding: "10px 14px",
                  background: "rgba(99,179,237,0.15)",
                  border: "1px solid rgba(99,179,237,0.3)",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                ⏳ <strong>Trial period — {trialDaysLeft} day{trialDaysLeft !== 1 ? "s" : ""} remaining.</strong>{" "}
                During your 7-day trial a weekly limit of {trialCreditsLimit} credits is enforced.
                Once your trial ends and you stay subscribed, your full {fullCreditsLimit} credits/month become available.
              </div>
            )}          </div>

          {/* Right: days until reset */}
          <div
            style={{
              background: "rgba(255,255,255,0.08)",
              borderRadius: 12,
              padding: "16px 24px",
              textAlign: "center",
              minWidth: 130,
              border: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            <div style={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>{daysLeft}</div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, opacity: 0.7, marginTop: 2 }}>
              days left
            </div>
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>until credits reset</div>
          </div>
        </div>

        {/* Warning banners inline */}
        {creditsUsed >= creditsLimit && (
          <div
            style={{
              marginTop: 16,
              padding: "10px 14px",
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            {isOnTrial
              ? `You’ve used all ${trialCreditsLimit} trial credits. Your full ${fullCreditsLimit} credits/month unlock when your trial ends in ${trialDaysLeft} day${trialDaysLeft !== 1 ? "s" : ""}.`
              : !isPaid
              ? "You've used all your credits this month. Upgrade to a paid plan for more credits."
              : `Your credits reset in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}.`}
          </div>
        )}
        {creditsUsed < creditsLimit && creditsUsed >= creditsLimit * 0.8 && (
          <div
            style={{
              marginTop: 16,
              padding: "10px 14px",
              background: "rgba(245,158,11,0.15)",
              border: "1px solid rgba(245,158,11,0.3)",
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            You have {creditsRemaining} credit{creditsRemaining !== 1 ? "s" : ""} remaining this month.
            {!isPaid && " Consider upgrading for more credits."}
          </div>
        )}
      </div>

      {/* ── Plan Cards ───────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <PlanCard
          name="Free"
          price={0}
          priceLabel="$0"
          subtitle="Forever free"
          isCurrent={currentPlan === "free"}
          isPrimary={false}
          features={[
            { text: "✓ 25 AI credits per month", bold: true },
            { text: "≈ Enough to publish ~5 designs" },
            { text: "✓ Canvas design editor" },
            { text: "✓ AI mockup generation" },
            { text: "✓ Printful integration" },
            { text: "✓ Unlimited publishes" },
          ]}
          downgradeLabel={isPaid ? undefined : undefined}
        />

        <PlanCard
          name="Pro"
          price={19.99}
          priceLabel="$19.99"
          subtitle="7-day free trial"
          isCurrent={currentPlan === "pro"}
          isPrimary={currentPlan === "free"}
          features={[
            { text: "✓ 150 AI credits per month", bold: true },
            { text: "≈ Enough to publish ~30 designs" },
            { text: "✓ Canvas design editor" },
            { text: "✓ AI mockup generation" },
            { text: "✓ Printful integration" },
            { text: "✓ Unlimited publishes" },
          ]}
          buttonLabel={currentPlan === "free" ? "Start 7-Day Free Trial" : currentPlan === "gold" ? "Switch to Pro" : undefined}
          onAction={() => handleUpgrade("pro")}
          loading={actionLoading === "pro"}
          downgradeLabel={currentPlan === "pro" ? "Cancel Subscription" : undefined}
          onDowngrade={() => setShowCancelModal(true)}
        />

        <PlanCard
          name="Gold"
          price={39.99}
          priceLabel="$39.99"
          subtitle="7-day free trial"
          isCurrent={currentPlan === "gold"}
          isPrimary={currentPlan !== "gold"}
          bestValue
          features={[
            { text: "✓ 400 AI credits per month", bold: true },
            { text: "≈ Enough to publish ~80 designs" },
            { text: "✓ Canvas design editor" },
            { text: "✓ AI mockup generation" },
            { text: "✓ Printful integration" },
            { text: "✓ Unlimited publishes" },
            { text: "🏷️ Best value — $0.10/credit", bold: true },
          ]}
          buttonLabel={currentPlan !== "gold" ? "Upgrade to Gold" : undefined}
          onAction={() => handleUpgrade("gold")}
          loading={actionLoading === "gold"}
          downgradeLabel={currentPlan === "gold" ? "Cancel Subscription" : undefined}
          onDowngrade={() => setShowCancelModal(true)}
        />
      </div>

      {/* ── What uses credits? ───────────────────────────────────────── */}
      <div
        style={{
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: 14,
          padding: "20px 24px",
        }}
      >
        <Text variant="headingSm" as="h3">What uses credits?</Text>
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[
            { badge: "1 credit", tone: "attention", text: "Each AI design generation (even if you don't publish)" },
            { badge: "Free", tone: "success", text: "Publishing products to your Shopify store" },
            { badge: "Free", tone: "success", text: "Canvas editor edits & downloads" },
            { badge: "Free", tone: "success", text: "Browsing your design library" },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Badge tone={item.tone}>{item.badge}</Badge>
              <Text variant="bodyMd">{item.text}</Text>
            </div>
          ))}
        </div>
      </div>

      {/* ── Value comparison ─────────────────────────────────────────── */}
      <div
        style={{
          background: "linear-gradient(135deg, #fef9ec 0%, #fef3cd 100%)",
          border: "1px solid #e0b84d",
          borderRadius: 14,
          padding: "20px 24px",
        }}
      >
        <Text variant="headingSm" as="h3">💰 Cost per credit comparison</Text>
        <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          {[
            { plan: "Free", cost: "Free (limited)", color: "#5c6ac4" },
            { plan: "Pro", cost: "$0.13/credit", color: "#1a73e8" },
            { plan: "Gold", cost: "$0.10/credit", color: "#b8860b" },
          ].map((item, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                minWidth: 140,
                background: "#fff",
                borderRadius: 10,
                padding: "12px 16px",
                textAlign: "center",
                border: `1px solid ${item.color}20`,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: item.color }}>{item.plan}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{item.cost}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Subscription Details (paid only) ─────────────────────────── */}
      {isPaid && billing?.subscriptionId && (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 14,
            padding: "20px 24px",
          }}
        >
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
        </div>
      )}

      {/* ── Cancel Modal ─────────────────────────────────────────────── */}
      {showCancelModal && (
        <Modal
          open={showCancelModal}
          onClose={() => setShowCancelModal(false)}
          title="Cancel Subscription?"
          primaryAction={{
            content: "Cancel Subscription",
            destructive: true,
            onAction: handleCancel,
            loading: actionLoading === "cancel",
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
                Are you sure you want to cancel your {currentPlan === "gold" ? "Gold" : "Pro"} subscription?
              </Text>
              <Text variant="bodyMd">
                You'll be downgraded to the Free plan with 25 credits/month (enough for ~5 designs).
              </Text>
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
