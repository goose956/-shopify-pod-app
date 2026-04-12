const express = require("express");
const log = require("../utils/logger");

/**
 * Billing API routes — plan management, subscription create/cancel, usage info.
 */
function createBillingRouter({ authService, billingService, settingsRepository, config }) {
  const router = express.Router();

  async function requireShopifySession(req, res) {
    const session = await authService.validateRequest(req);
    if (!session?.shopDomain) {
      res.status(401).json({ error: "Invalid or missing session token" });
      return null;
    }
    return session;
  }

  /* ── GET /billing/plans — list available plans ──────────────────────── */
  router.get("/plans", async (req, res) => {
    const session = await requireShopifySession(req, res);
    if (!session) return;

    const plans = billingService.getPlans();
    res.json({ plans });
  });

  /* ── GET /billing/status — current plan, usage, subscription info ──── */
  router.get("/status", async (req, res) => {
    const session = await requireShopifySession(req, res);
    if (!session) return;

    try {
      // Sync with Shopify to get latest subscription status
      await billingService.syncSubscriptionStatus(session.shopDomain);
    } catch (err) {
      log.warn({ err: err.message }, "Failed to sync subscription status");
      // Continue — show cached data
    }

    const billing = billingService.getShopBilling(session.shopDomain);
    res.json(billing);
  });

  /* ── POST /billing/subscribe — create a new subscription ───────────── */
  router.post("/subscribe", async (req, res) => {
    const session = await requireShopifySession(req, res);
    if (!session) return;

    const planId = String(req.body?.plan || "pro").trim();
    const plan = billingService.getPlan(planId);

    if (!plan || plan.price === 0) {
      return res.status(400).json({ error: "Invalid plan. Use 'pro' or 'gold'." });
    }

    try {
      const hostName = config.shopify.hostName.replace(/^https?:\/\//, "");
      const returnUrl = `https://${hostName}/?billing_confirmed=true&plan=${planId}`;

      const result = await billingService.createSubscription(
        session.shopDomain,
        planId,
        returnUrl
      );

      res.json({
        confirmationUrl: result.confirmationUrl,
        subscriptionId: result.subscriptionId,
      });
    } catch (err) {
      log.error({ err: err.message }, "Subscribe error");
      res.status(500).json({ error: err.message });
    }
  });

  /* ── POST /billing/confirm — confirm subscription after redirect ──── */
  router.post("/confirm", async (req, res) => {
    const session = await requireShopifySession(req, res);
    if (!session) return;

    try {
      const result = await billingService.syncSubscriptionStatus(session.shopDomain);
      await settingsRepository.flush();

      res.json({
        ok: true,
        ...result,
        billing: billingService.getShopBilling(session.shopDomain),
      });
    } catch (err) {
      log.error({ err: err.message }, "Confirm error");
      res.status(500).json({ error: err.message });
    }
  });

  /* ── POST /billing/cancel — cancel subscription ────────────────────── */
  router.post("/cancel", async (req, res) => {
    const session = await requireShopifySession(req, res);
    if (!session) return;

    try {
      const result = await billingService.cancelSubscription(session.shopDomain);
      await settingsRepository.flush();

      res.json({
        ok: true,
        ...result,
        billing: billingService.getShopBilling(session.shopDomain),
      });
    } catch (err) {
      log.error({ err: err.message }, "Cancel error");
      res.status(500).json({ error: err.message });
    }
  });

  /* ── POST /billing/downgrade — switch to free plan ─────────────────── */
  router.post("/downgrade", async (req, res) => {
    const session = await requireShopifySession(req, res);
    if (!session) return;

    try {
      const result = await billingService.cancelSubscription(session.shopDomain);
      await settingsRepository.flush();

      res.json({
        ok: true,
        message: "Downgraded to Free plan.",
        ...result,
        billing: billingService.getShopBilling(session.shopDomain),
      });
    } catch (err) {
      log.error({ err: err.message }, "Downgrade error");
      res.status(500).json({ error: err.message });
    }
  });

  /* ── POST /billing/reset-usage — reset credits to 0 (dev/testing) ── */
  router.post("/reset-usage", async (req, res) => {
    const session = await requireShopifySession(req, res);
    if (!session) return;

    try {
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      settingsRepository.upsertByShop(session.shopDomain, {
        billingUsage: { credits: 0, periodStart },
      });
      log.info({ shop: session.shopDomain }, "Usage credits reset to 0");
      res.json({
        ok: true,
        billing: billingService.getShopBilling(session.shopDomain),
      });
    } catch (err) {
      log.error({ err: err.message }, "Reset usage error");
      res.status(500).json({ error: err.message });
    }
  });

  /* ── POST /billing/check-credits — pre-flight credit check ─────────── */
  router.post("/check-credits", async (req, res) => {
    const session = await requireShopifySession(req, res);
    if (!session) return;

    const creditsNeeded = Math.max(1, Math.floor(Number(req.body?.creditsNeeded) || 1));
    const result = billingService.canAfford(session.shopDomain, creditsNeeded);
    res.json(result);
  });

  return router;
}

module.exports = { createBillingRouter };
