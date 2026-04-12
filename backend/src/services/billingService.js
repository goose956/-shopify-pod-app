/**
 * Shopify Billing Service
 *
 * Manages recurring app subscriptions via the Shopify GraphQL Admin API.
 * Supports a free tier and a "Pro" paid tier with usage tracking.
 */

const TRIAL_CREDIT_FRACTION = 0.25; // During trial, only 25% of monthly credits are available

const PLANS = {
  free: {
    name: "Free",
    price: 0,
    creditsPerMonth: 25,
    trialDays: 0,
  },
  pro: {
    name: "Pro",
    price: 19.99,
    creditsPerMonth: 150,
    trialDays: 7,
  },
  gold: {
    name: "Gold",
    price: 39.99,
    creditsPerMonth: 400,
    trialDays: 7,
  },
};

class BillingService {
  constructor(settingsRepository, config) {
    this.settingsRepository = settingsRepository;
    this.config = config;
  }

  /* ── Plan definitions ──────────────────────────────────────────────── */
  getPlans() {
    return PLANS;
  }

  getPlan(planId) {
    return PLANS[planId] || PLANS.free;
  }

  /* ── Current plan & usage for a shop ───────────────────────────────── */
  getShopBilling(shopDomain) {
    const settings = this.settingsRepository.findByShop(shopDomain) || {};
    const planId = settings.billingPlan || "free";
    const plan = this.getPlan(planId);

    // Reset usage if we are in a new billing month
    const usage = this._getCurrentUsage(settings);

    // Determine if shop is currently within the trial window
    const trialEndsAt = settings.billingTrialEndsAt || null;
    const isOnTrial = !!(trialEndsAt && new Date(trialEndsAt) > new Date());
    const trialCreditsLimit = isOnTrial
      ? Math.floor(plan.creditsPerMonth * TRIAL_CREDIT_FRACTION)
      : null;

    // Effective limit is the trial cap when on trial, full credits otherwise
    const effectiveLimit = isOnTrial ? trialCreditsLimit : plan.creditsPerMonth;

    return {
      plan: planId,
      planName: plan.name,
      price: plan.price,
      limits: {
        creditsPerMonth: plan.creditsPerMonth,
        effectiveLimit,
      },
      usage: {
        credits: usage.credits,
        periodStart: usage.periodStart,
      },
      subscriptionId: settings.billingSubscriptionId || null,
      subscriptionStatus: settings.billingSubscriptionStatus || null,
      trialEndsAt,
      isOnTrial,
      trialCreditsLimit,
    };
  }

  /* ── Check if an action is within limits ───────────────────────────── */
  canPerformAction(shopDomain, action) {
    const billing = this.getShopBilling(shopDomain);
    const { credits } = billing.usage;
    const { effectiveLimit, creditsPerMonth } = billing.limits;

    // During trial the effective limit is 25% of monthly credits
    return {
      allowed: credits < effectiveLimit,
      current: credits,
      limit: effectiveLimit,
      fullLimit: creditsPerMonth,
      isOnTrial: billing.isOnTrial,
      action,
    };
  }

  /* ── Pre-flight check: can the shop afford N credits? ──────────────── */
  canAfford(shopDomain, creditsNeeded) {
    const billing = this.getShopBilling(shopDomain);
    const { credits } = billing.usage;
    const { effectiveLimit, creditsPerMonth } = billing.limits;
    const remaining = effectiveLimit - credits;

    return {
      allowed: remaining >= creditsNeeded,
      creditsNeeded,
      remaining,
      current: credits,
      limit: effectiveLimit,
      fullLimit: creditsPerMonth,
      isOnTrial: billing.isOnTrial,
      plan: billing.plan,
    };
  }

  /* ── Increment usage counter ───────────────────────────────────────── */
  recordUsage(shopDomain, action = "unknown") {
    const settings = this.settingsRepository.findByShop(shopDomain) || {};
    const usage = this._getCurrentUsage(settings);

    usage.credits += 1;

    // Append to usage log
    const log = this._getUsageLog(settings);
    log.push({
      type: "credit",
      action,
      credits: 1,
      total: usage.credits,
      ts: new Date().toISOString(),
    });

    this.settingsRepository.upsertByShop(shopDomain, {
      billingUsage: usage,
      billingUsageLog: log.slice(-200), // keep last 200 entries
    });
  }

  /* ── Log an error (no credit charged) ──────────────────────────────── */
  recordError(shopDomain, action, errorMessage) {
    const settings = this.settingsRepository.findByShop(shopDomain) || {};
    const log = this._getUsageLog(settings);
    log.push({
      type: "error",
      action,
      error: String(errorMessage || "Unknown error").slice(0, 500),
      ts: new Date().toISOString(),
    });

    this.settingsRepository.upsertByShop(shopDomain, {
      billingUsageLog: log.slice(-200),
    });
  }

  /* ── Get the usage log for a shop ──────────────────────────────────── */
  getUsageLog(shopDomain) {
    const settings = this.settingsRepository.findByShop(shopDomain) || {};
    return this._getUsageLog(settings);
  }

  _getUsageLog(settings) {
    return Array.isArray(settings.billingUsageLog) ? [...settings.billingUsageLog] : [];
  }

  /* ── Create a Shopify subscription (returns confirmation URL) ─────── */
  async createSubscription(shopDomain, planId, returnUrl) {
    const plan = this.getPlan(planId);
    if (!plan || plan.price === 0) {
      throw new Error("Cannot create a subscription for the free plan.");
    }

    const accessToken = this._getAccessToken(shopDomain);
    if (!accessToken) {
      throw new Error("No access token found for this shop. Please reinstall the app.");
    }

    const mutation = `
      mutation appSubscriptionCreate($name: String!, $returnUrl: URL!, $trialDays: Int!, $lineItems: [AppSubscriptionLineItemInput!]!) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          trialDays: $trialDays
          replacementBehavior: APPLY_IMMEDIATELY
          test: ${process.env.NODE_ENV !== "production" ? "true" : "false"}
          lineItems: $lineItems
        ) {
          appSubscription {
            id
            status
            trialDays
          }
          confirmationUrl
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      name: `ListingLab — ${plan.name}`,
      returnUrl,
      trialDays: plan.trialDays,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: plan.price, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
    };

    const result = await this._graphql(shopDomain, accessToken, mutation, variables);
    const data = result?.data?.appSubscriptionCreate;

    if (data?.userErrors?.length > 0) {
      const msg = data.userErrors.map((e) => e.message).join("; ");
      throw new Error(`Shopify billing error: ${msg}`);
    }

    if (!data?.confirmationUrl) {
      throw new Error("Failed to create subscription — no confirmation URL returned.");
    }

    // Store pending subscription info + trial dates
    const trialEndsAt = plan.trialDays > 0
      ? new Date(Date.now() + plan.trialDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    this.settingsRepository.upsertByShop(shopDomain, {
      billingPendingPlan: planId,
      billingSubscriptionId: data.appSubscription?.id || null,
      billingTrialStartedAt: plan.trialDays > 0 ? new Date().toISOString() : null,
      billingTrialEndsAt: trialEndsAt,
    });

    return {
      confirmationUrl: data.confirmationUrl,
      subscriptionId: data.appSubscription?.id,
    };
  }

  /* ── Check & sync active subscription status from Shopify ──────────── */
  async syncSubscriptionStatus(shopDomain) {
    const accessToken = this._getAccessToken(shopDomain);
    if (!accessToken) return null;

    const query = `
      {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            trialDays
            currentPeriodEnd
            test
            lineItems {
              plan {
                pricingDetails {
                  ... on AppRecurringPricing {
                    price { amount currencyCode }
                    interval
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await this._graphql(shopDomain, accessToken, query);
    const subs = result?.data?.currentAppInstallation?.activeSubscriptions || [];

    if (subs.length === 0) {
      // No active subscription — set to free
      this.settingsRepository.upsertByShop(shopDomain, {
        billingPlan: "free",
        billingSubscriptionId: null,
        billingSubscriptionStatus: null,
        billingPendingPlan: null,
        billingTrialEndsAt: null,
      });
      return { plan: "free", status: "none" };
    }

    // Take the first active subscription
    const sub = subs[0];
    const price = sub.lineItems?.[0]?.plan?.pricingDetails?.price?.amount;

    // Determine plan based on price
    let planId = "free";
    const priceNum = parseFloat(price);
    if (priceNum >= 39) {
      planId = "gold";
    } else if (priceNum >= 19) {
      planId = "pro";
    }

    // Calculate trial end date
    const existingSettings = this.settingsRepository.findByShop(shopDomain) || {};
    let trialEndsAt = existingSettings.billingTrialEndsAt || null;

    if (sub.trialDays > 0 && sub.status === "ACTIVE") {
      // If we have no stored trial end date, compute from trial start or now
      if (!trialEndsAt) {
        const trialStart = existingSettings.billingTrialStartedAt
          ? new Date(existingSettings.billingTrialStartedAt)
          : new Date();
        trialEndsAt = new Date(trialStart.getTime() + sub.trialDays * 24 * 60 * 60 * 1000).toISOString();
      }
    } else if (sub.trialDays === 0 || !sub.trialDays) {
      // No trial on this subscription — clear trial dates
      trialEndsAt = null;
    }

    this.settingsRepository.upsertByShop(shopDomain, {
      billingPlan: planId,
      billingSubscriptionId: sub.id,
      billingSubscriptionStatus: sub.status,
      billingPendingPlan: null,
      billingTrialEndsAt: trialEndsAt,
      billingTrialStartedAt: existingSettings.billingTrialStartedAt || null,
    });

    return {
      plan: planId,
      status: sub.status,
      subscriptionId: sub.id,
      test: sub.test,
    };
  }

  /* ── Cancel subscription ──────────────────────────────────────────── */
  async cancelSubscription(shopDomain) {
    const settings = this.settingsRepository.findByShop(shopDomain) || {};
    const subscriptionId = settings.billingSubscriptionId;

    if (!subscriptionId) {
      // Just reset to free with fresh credits
      this.settingsRepository.upsertByShop(shopDomain, {
        billingPlan: "free",
        billingSubscriptionId: null,
        billingSubscriptionStatus: null,
        billingPendingPlan: null,
        billingUsage: { credits: 0, periodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
      });
      return { ok: true, plan: "free" };
    }

    const accessToken = this._getAccessToken(shopDomain);
    if (!accessToken) {
      throw new Error("No access token found.");
    }

    const mutation = `
      mutation appSubscriptionCancel($id: ID!) {
        appSubscriptionCancel(id: $id) {
          appSubscription {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const result = await this._graphql(shopDomain, accessToken, mutation, { id: subscriptionId });
    const data = result?.data?.appSubscriptionCancel;

    if (data?.userErrors?.length > 0) {
      const msg = data.userErrors.map((e) => e.message).join("; ");
      throw new Error(`Cancel error: ${msg}`);
    }

    this.settingsRepository.upsertByShop(shopDomain, {
      billingPlan: "free",
      billingSubscriptionId: null,
      billingSubscriptionStatus: "CANCELLED",
      billingPendingPlan: null,
      billingUsage: { credits: 0, periodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
    });

    return { ok: true, plan: "free", previousSubscriptionId: subscriptionId };
  }

  /* ── Private helpers ──────────────────────────────────────────────── */

  _getAccessToken(shopDomain) {
    const settings = this.settingsRepository.findByShop(shopDomain) || {};
    if (settings.shopifyAccessToken) return settings.shopifyAccessToken;
    // Dev/test fallback only — never use a global token in production
    if (process.env.NODE_ENV !== "production" && this.config.shopify.adminAccessToken) {
      return this.config.shopify.adminAccessToken;
    }
    return "";
  }

  _getCurrentUsage(settings) {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    let usage = settings.billingUsage || {};

    // Reset if we are in a new period
    if (usage.periodStart !== periodStart) {
      usage = { credits: 0, periodStart };
    }

    // Migration: convert old dual-counter format to unified credits
    if (typeof usage.credits === "undefined") {
      usage.credits = (usage.designs || 0) + (usage.publishes || 0);
      delete usage.designs;
      delete usage.publishes;
    }

    return usage;
  }

  async _graphql(shopDomain, accessToken, query, variables = {}) {
    const apiVersion = this.config.shopify.apiVersion || "2025-10";
    const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Shopify GraphQL error (${resp.status}): ${text.slice(0, 300)}`);
    }

    return resp.json();
  }
}

module.exports = { BillingService, PLANS };
