import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  Divider,
  FormLayout,
  Icon,
  InlineGrid,
  InlineStack,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  ChartDonutIcon,
  PersonIcon,
  SettingsIcon,
  RefreshIcon,
} from "@shopify/polaris-icons";
import { getSessionToken } from "../utils/sessionToken";

function StatCard({ label, value, tone = "base" }) {
  const bg = { base: "#f6f6f7", info: "#e8f5ff", success: "#f0fff4", warning: "#fff8e1", critical: "#fff0f0" };
  const fg = { base: "#303030", info: "#0070cc", success: "#1a7a3a", warning: "#916a00", critical: "#d72c0d" };
  return (
    <div
      style={{
        background: bg[tone] ?? bg.base,
        border: "1px solid #e1e3e5",
        borderRadius: 12,
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minHeight: 90,
      }}
    >
      <Text variant="bodyMd" tone="subdued" as="p">{label}</Text>
      <Text variant="heading2xl" as="p" fontWeight="bold" style={{ color: fg[tone] ?? fg.base }}>
        {value ?? "—"}
      </Text>
    </div>
  );
}

function SectionHeader({ icon, title, action }) {
  return (
    <InlineStack align="space-between" blockAlign="center">
      <InlineStack gap="200" blockAlign="center">
        {icon && (
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "#f1f2f3", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon source={icon} tone="base" />
          </div>
        )}
        <Text variant="headingMd" as="h2" fontWeight="semibold">{title}</Text>
      </InlineStack>
      {action}
    </InlineStack>
  );
}

export function AdminDashboard() {
  const [keiAiApiKey, setKeiAiApiKey] = useState("");
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [kieGenerateUrl, setKieGenerateUrl] = useState("https://api.kie.ai/api/v1/gpt4o-image/generate");
  const [kieEditUrl, setKieEditUrl] = useState("https://api.kie.ai/api/v1/gpt4o-image/generate");
  const [printfulApiKey, setPrintfulApiKey] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [isTestingKie, setIsTestingKie] = useState(false);
  const [kieTestMessage, setKieTestMessage] = useState("");
  const [kieTestTone, setKieTestTone] = useState("warning");
  const [isTestingOpenAi, setIsTestingOpenAi] = useState(false);
  const [openAiTestMessage, setOpenAiTestMessage] = useState("");
  const [openAiTestTone, setOpenAiTestTone] = useState("warning");

  const [analytics, setAnalytics] = useState(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(false);
  const [analyticsError, setAnalyticsError] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberPassword, setMemberPassword] = useState("");
  const [isRegisteringMember, setIsRegisteringMember] = useState(false);
  const [memberMessage, setMemberMessage] = useState("");
  const [memberError, setMemberError] = useState("");

  // ── Analytics ─────────────────────────────────────────────────────────────
  const loadAnalytics = useCallback(async () => {
    setAnalyticsError("");
    setIsLoadingAnalytics(true);
    try {
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/admin/analytics", {
        headers: { "X-Shopify-Session-Token": sessionToken },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load analytics");
      }
      setAnalytics(await response.json());
    } catch (err) {
      setAnalyticsError(err.message || "Failed to load analytics");
    } finally {
      setIsLoadingAnalytics(false);
    }
  }, []);

  useEffect(() => { loadAnalytics(); }, [loadAnalytics]);

  // ── Settings ───────────────────────────────────────────────────────────────
  const loadSettings = useCallback(async () => {
    setSettingsError("");
    try {
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/settings", {
        headers: { "X-Shopify-Session-Token": sessionToken },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load API keys");
      }
      const data = await response.json();
      setOpenAiApiKey(data.openAiApiKey || "");
      setKeiAiApiKey(data.keiAiApiKey || "");
      setKieGenerateUrl(data.kieGenerateUrl || "https://api.kie.ai/api/v1/gpt4o-image/generate");
      setKieEditUrl(data.kieEditUrl || "https://api.kie.ai/api/v1/gpt4o-image/generate");
      setPrintfulApiKey(data.printfulApiKey || "");
    } catch (err) {
      setSettingsError(err.message || "Failed to load API keys");
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const saveSettings = useCallback(async () => {
    setSettingsError("");
    setSettingsMessage("");
    setIsSavingSettings(true);
    try {
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
        body: JSON.stringify({ keiAiApiKey, openAiApiKey, kieGenerateUrl, kieEditUrl, printfulApiKey }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save settings");
      }
      setSettingsMessage("Settings saved successfully.");
    } catch (err) {
      setSettingsError(err.message || "Failed to save API keys");
    } finally {
      setIsSavingSettings(false);
    }
  }, [keiAiApiKey, openAiApiKey, kieGenerateUrl, kieEditUrl, printfulApiKey]);

  const testKieConnection = useCallback(async () => {
    setKieTestMessage("");
    setIsTestingKie(true);
    try {
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/settings/test-kie", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
        body: JSON.stringify({ keiAiApiKey, kieGenerateUrl }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "KIE test failed");
      }
      const data = await response.json();
      setKieTestTone(data.provider === "kie" ? "success" : "warning");
      setKieTestMessage(`Provider: ${data.provider}. Endpoint: ${data.endpoint}. ${data.message}`);
    } catch (err) {
      setKieTestTone("critical");
      setKieTestMessage(err.message || "KIE test failed");
    } finally {
      setIsTestingKie(false);
    }
  }, [keiAiApiKey, kieGenerateUrl]);

  const testOpenAiConnection = useCallback(async () => {
    setOpenAiTestMessage("");
    setIsTestingOpenAi(true);
    try {
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/settings/test-openai", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Session-Token": sessionToken },
        body: JSON.stringify({ openAiApiKey }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "OpenAI test failed");
      }
      const data = await response.json();
      const copyOk = data.provider === "openai";
      const imgOk = data.imageProvider === "gpt-image-1" || data.imageProvider === "dall-e-3";
      setOpenAiTestTone(copyOk && imgOk ? "success" : copyOk ? "warning" : "critical");
      const imgLine = data.imageMessage ? ` | Image: ${data.imageProvider} — ${data.imageMessage}` : "";
      setOpenAiTestMessage(
        `Text (${data.provider}): ${data.message}${data.sampleTitle ? ` · Sample: "${data.sampleTitle}"` : ""}${imgLine}`
      );
    } catch (err) {
      setOpenAiTestTone("critical");
      setOpenAiTestMessage(err.message || "OpenAI test failed");
    } finally {
      setIsTestingOpenAi(false);
    }
  }, [openAiApiKey]);

  // ── Members ────────────────────────────────────────────────────────────────
  const registerMember = useCallback(async () => {
    setMemberMessage("");
    setMemberError("");
    setIsRegisteringMember(true);
    try {
      const response = await fetch("/api/members/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: memberEmail, fullName: memberName, password: memberPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to register member");
      setMemberMessage(`Member created: ${data.member?.email || memberEmail}`);
      setMemberEmail("");
      setMemberName("");
      setMemberPassword("");
      await loadAnalytics();
    } catch (err) {
      setMemberError(err.message || "Failed to register member");
    } finally {
      setIsRegisteringMember(false);
    }
  }, [memberEmail, memberName, memberPassword, loadAnalytics]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function formatDate(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <BlockStack gap="600">

      {/* ── Analytics ──────────────────────────────────────────────────────── */}
      <Card>
        <BlockStack gap="400">
          <SectionHeader
            icon={ChartDonutIcon}
            title="Analytics Overview"
            action={
              <Button icon={RefreshIcon} onClick={loadAnalytics} loading={isLoadingAnalytics} size="slim" variant="plain">
                Refresh
              </Button>
            }
          />
          {analyticsError && <Banner tone="critical" title="Analytics error"><p>{analyticsError}</p></Banner>}
          {isLoadingAnalytics && !analytics && (
            <InlineStack align="center"><Spinner size="small" /></InlineStack>
          )}
          {analytics && (
            <>
              <InlineGrid columns={{ xs: 2, sm: 3 }} gap="300">
                <StatCard label="Total API Requests"   value={analytics.visitors?.totalRequests ?? 0}       tone="info"    />
                <StatCard label="Unique Visitors"       value={analytics.visitors?.uniqueVisitors ?? 0}      tone="info"    />
                <StatCard label="Requests (Last 24 h)"  value={analytics.visitors?.last24h?.requests ?? 0}               />
                <StatCard label="Visitors (Last 24 h)"  value={analytics.visitors?.last24h?.visitors ?? 0}               />
                <StatCard label="Total Members"         value={analytics.totals?.members ?? 0}               tone="success" />
                <StatCard label="Designs Created"       value={analytics.totals?.designs ?? 0}               tone="success" />
              </InlineGrid>
              {(analytics.visitors?.topPaths || []).length > 0 && (
                <Box paddingBlockStart="200">
                  <BlockStack gap="200">
                    <Text variant="headingSm" as="h3" tone="subdued">Top API Paths</Text>
                    <DataTable
                      columnContentTypes={["text", "numeric"]}
                      headings={["Path", "Requests"]}
                      rows={(analytics.visitors.topPaths || []).map((item) => [
                        <Text variant="bodySm" as="span" key={item.path}>{item.path}</Text>,
                        item.count,
                      ])}
                    />
                  </BlockStack>
                </Box>
              )}
            </>
          )}
        </BlockStack>
      </Card>

      {/* ── Member Accounts ────────────────────────────────────────────────── */}
      <Card>
        <BlockStack gap="400">
          <SectionHeader icon={PersonIcon} title="Member Accounts" />
          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="500">
            <Box background="bg-surface-secondary" borderRadius="300" padding="400" borderWidth="025" borderColor="border">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">Register New Member</Text>
                <FormLayout>
                  <TextField label="Full name" value={memberName} onChange={setMemberName} autoComplete="off" placeholder="Jane Smith" />
                  <TextField label="Email address" value={memberEmail} onChange={setMemberEmail} autoComplete="off" placeholder="jane@example.com" />
                  <TextField label="Password" type="password" value={memberPassword} onChange={setMemberPassword} autoComplete="new-password" />
                  <Button variant="primary" onClick={registerMember} loading={isRegisteringMember} disabled={!memberEmail.trim() || !memberPassword.trim()} fullWidth>
                    Create Member
                  </Button>
                </FormLayout>
                {memberMessage && <Banner tone="success"><p>{memberMessage}</p></Banner>}
                {memberError   && <Banner tone="critical"><p>{memberError}</p></Banner>}
              </BlockStack>
            </Box>
            <BlockStack gap="300">
              <Text variant="headingSm" as="h3">Recent Members</Text>
              {(analytics?.recentMembers || []).length === 0 ? (
                <Box background="bg-surface-secondary" borderRadius="300" padding="400" borderWidth="025" borderColor="border">
                  <Text tone="subdued" as="p" alignment="center">No members registered yet.</Text>
                </Box>
              ) : (
                <BlockStack gap="200">
                  {(analytics?.recentMembers || []).map((member) => (
                    <Box key={member.id} background="bg-surface-secondary" borderRadius="200" padding="300" borderWidth="025" borderColor="border">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="050">
                          <Text variant="bodyMd" fontWeight="medium" as="p">{member.fullName || "—"}</Text>
                          <Text variant="bodySm" tone="subdued" as="p">{member.email}</Text>
                        </BlockStack>
                        <InlineStack gap="300" blockAlign="center">
                          <Badge tone={member.designCount > 0 ? "success" : "base"}>
                            {member.designCount} {member.designCount === 1 ? "design" : "designs"}
                          </Badge>
                          <Text variant="bodySm" tone="subdued" as="p">{formatDate(member.createdAt)}</Text>
                        </InlineStack>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </InlineGrid>
        </BlockStack>
      </Card>

      {/* ── API Configuration ──────────────────────────────────────────────── */}
      <Card>
        <BlockStack gap="400">
          <SectionHeader icon={SettingsIcon} title="API Configuration" />
          <Banner tone="info">
            <p><strong>OpenAI</strong> is the primary provider for images and copy. <strong>KIE</strong> is the fallback.</p>
          </Banner>
          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
            <Box background="bg-surface-secondary" borderRadius="300" padding="400" borderWidth="025" borderColor="border">
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="success">Primary</Badge>
                  <Text variant="headingSm" as="h3">OpenAI</Text>
                </InlineStack>
                <FormLayout>
                  <TextField label="API Key" type="password" value={openAiApiKey} onChange={setOpenAiApiKey} autoComplete="off" placeholder="sk-..." />
                </FormLayout>
                <Button onClick={testOpenAiConnection} loading={isTestingOpenAi} size="slim">Test Connection</Button>
                {openAiTestMessage && <Banner tone={openAiTestTone}><p>{openAiTestMessage}</p></Banner>}
              </BlockStack>
            </Box>
            <Box background="bg-surface-secondary" borderRadius="300" padding="400" borderWidth="025" borderColor="border">
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="info">Mockups</Badge>
                  <Text variant="headingSm" as="h3">Printful</Text>
                </InlineStack>
                <FormLayout>
                  <TextField label="API Token" type="password" value={printfulApiKey} onChange={setPrintfulApiKey} autoComplete="off" placeholder="Your Printful API token" helpText="Free at printful.com → Dashboard → Settings → API" />
                </FormLayout>
              </BlockStack>
            </Box>
          </InlineGrid>
          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
            <Box background="bg-surface-secondary" borderRadius="300" padding="400" borderWidth="025" borderColor="border">
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="warning">Fallback</Badge>
                  <Text variant="headingSm" as="h3">KIE.ai</Text>
                </InlineStack>
                <FormLayout>
                  <TextField label="API Key" type="password" value={keiAiApiKey} onChange={setKeiAiApiKey} autoComplete="off" />
                  <TextField label="Generate URL" value={kieGenerateUrl} onChange={setKieGenerateUrl} autoComplete="off" />
                  <TextField label="Edit URL" value={kieEditUrl} onChange={setKieEditUrl} autoComplete="off" />
                </FormLayout>
                <Button onClick={testKieConnection} loading={isTestingKie} size="slim">Test Connection</Button>
                {kieTestMessage && <Banner tone={kieTestTone}><p>{kieTestMessage}</p></Banner>}
              </BlockStack>
            </Box>
          </InlineGrid>
          <Divider />
          <InlineStack align="end" gap="300">
            {settingsError   && <Text tone="critical" as="span">{settingsError}</Text>}
            {settingsMessage && <Text tone="success"  as="span">{settingsMessage}</Text>}
            <Button variant="primary" onClick={saveSettings} loading={isSavingSettings}>Save Configuration</Button>
          </InlineStack>
        </BlockStack>
      </Card>

    </BlockStack>
  );
}


