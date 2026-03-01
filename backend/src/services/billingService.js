/**
 * Shopify Billing Service
 *
 * Manages recurring app subscriptions via the Shopify GraphQL Admin API.
 * Supports a free tier and a "Pro" paid tier with usage tracking.
 */

const PLANS = {
  free: {
    name: "Free",
    price: 0,
    designsPerMonth: 5,
    publishesPerMonth: 5,
    trialDays: 0,
  },
  pro: {
    name: "Pro",
    price: 19.99,
    designsPerMonth: 30,
    publishesPerMonth: 30,
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

    return {
      plan: planId,
      planName: plan.name,
      price: plan.price,
      limits: {
        designsPerMonth: plan.designsPerMonth,
        publishesPerMonth: plan.publishesPerMonth,
      },
      usage: {
        designs: usage.designs,
        publishes: usage.publishes,
        periodStart: usage.periodStart,
      },
      subscriptionId: settings.billingSubscriptionId || null,
      subscriptionStatus: settings.billingSubscriptionStatus || null,
      trialEndsAt: settings.billingTrialEndsAt || null,
    };
  }

  /* ── Check if an action is within limits ───────────────────────────── */
  canPerformAction(shopDomain, action) {
    const billing = this.getShopBilling(shopDomain);
    const limits = billing.limits;
    const usage = billing.usage;

    if (action === "design") {
      return {
        allowed: usage.designs < limits.designsPerMonth,
        current: usage.designs,
        limit: limits.designsPerMonth,
        action,
      };
    }
    if (action === "publish") {
      return {
        allowed: usage.publishes < limits.publishesPerMonth,
        current: usage.publishes,
        limit: limits.publishesPerMonth,
        action,
      };
    }
    return { allowed: true, current: 0, limit: Infinity, action };
  }

  /* ── Increment usage counter ───────────────────────────────────────── */
  recordUsage(shopDomain, action) {
    const settings = this.settingsRepository.findByShop(shopDomain) || {};
    const usage = this._getCurrentUsage(settings);

    if (action === "design") {
      usage.designs += 1;
    } else if (action === "publish") {
      usage.publishes += 1;
    }

    this.settingsRepository.upsertByShop(shopDomain, {
      billingUsage: usage,
    });
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
      name: `POD Design Generator — ${plan.name}`,
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

    // Store pending subscription info
    this.settingsRepository.upsertByShop(shopDomain, {
      billingPendingPlan: planId,
      billingSubscriptionId: data.appSubscription?.id || null,
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
    if (parseFloat(price) >= 19) {
      planId = "pro";
    }

    // Calculate trial end date
    let trialEndsAt = null;
    if (sub.trialDays > 0 && sub.status === "ACTIVE") {
      // Shopify doesn't directly give trial end date in this query,
      // so we compute from currentPeriodEnd if needed
      trialEndsAt = this.settingsRepository.findByShop(shopDomain)?.billingTrialEndsAt || null;
    }

    this.settingsRepository.upsertByShop(shopDomain, {
      billingPlan: planId,
      billingSubscriptionId: sub.id,
      billingSubscriptionStatus: sub.status,
      billingPendingPlan: null,
      billingTrialEndsAt: trialEndsAt,
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
      // Just reset to free
      this.settingsRepository.upsertByShop(shopDomain, {
        billingPlan: "free",
        billingSubscriptionId: null,
        billingSubscriptionStatus: null,
        billingPendingPlan: null,
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
    });

    return { ok: true, plan: "free", previousSubscriptionId: subscriptionId };
  }

  /* ── Private helpers ──────────────────────────────────────────────── */

  _getAccessToken(shopDomain) {
    const settings = this.settingsRepository.findByShop(shopDomain) || {};
    return settings.shopifyAccessToken || this.config.shopify.adminAccessToken || "";
  }

  _getCurrentUsage(settings) {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    let usage = settings.billingUsage || {};

    // Reset if we are in a new period
    if (usage.periodStart !== periodStart) {
      usage = { designs: 0, publishes: 0, periodStart };
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
