const log = require("../utils/logger");

const PERSIST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

class AnalyticsService {
  /**
   * @param {object} [settingsRepository] — if provided, analytics are persisted to the store
   */
  constructor(settingsRepository) {
    this._settingsRepo = settingsRepository || null;
    this.startedAt = Date.now();
    this.totalRequests = 0;
    this.uniqueVisitors = new Set();
    this.pathCounts = new Map();
    this.recentRequests = [];
    this.maxRecent = 2000;

    // API cost tracking
    this.apiCalls = [];
    this.maxApiCalls = 5000;
    this.costRates = {
      "openai:gpt-image-1":       0.04,
      "openai:dall-e-3":          0.04,
      "openai:dall-e-2":          0.02,
      "openai:gpt-image-1:edit":  0.04,
      "openai:dall-e-2:edit":     0.02,
      "openai:gpt-4o-mini:chat":  0.00015,
      "kie:image":                0.03,
    };

    // Restore persisted cumulative counters
    this._restore();

    // Periodically persist cumulative counters
    if (this._settingsRepo) {
      this._persistTimer = setInterval(() => this._persist(), PERSIST_INTERVAL_MS);
      this._persistTimer.unref();
    }
  }

  buildVisitorId(req) {
    const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = forwardedFor || req.ip || req.socket?.remoteAddress || "unknown";
    const userAgent = String(req.headers["user-agent"] || "unknown");
    return `${ip}|${userAgent.slice(0, 120)}`;
  }

  track(req) {
    this.totalRequests += 1;

    const visitorId = this.buildVisitorId(req);
    this.uniqueVisitors.add(visitorId);

    const method = String(req.method || "GET").toUpperCase();
    const path = String(req.path || req.originalUrl || "");
    const key = `${method} ${path}`;
    this.pathCounts.set(key, (this.pathCounts.get(key) || 0) + 1);

    const now = Date.now();
    this.recentRequests.push({ at: now, key, visitorId });
    if (this.recentRequests.length > this.maxRecent) {
      this.recentRequests.splice(0, this.recentRequests.length - this.maxRecent);
    }
  }

  summarizeRecent(sinceMs) {
    const cutoff = Date.now() - sinceMs;
    const scoped = this.recentRequests.filter((item) => item.at >= cutoff);
    const visitors = new Set(scoped.map((item) => item.visitorId));
    return {
      requests: scoped.length,
      visitors: visitors.size,
    };
  }

  getSummary() {
    const topPaths = [...this.pathCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([path, count]) => ({ path, count }));

    const last24h = this.summarizeRecent(24 * 60 * 60 * 1000);
    const last1h = this.summarizeRecent(60 * 60 * 1000);

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      totalRequests: this.totalRequests,
      uniqueVisitors: this.uniqueVisitors.size + (this._restoredVisitorCount || 0),
      last24h,
      last1h,
      topPaths,
    };
  }

  /**
   * Record an API call with its provider, model, operation, and estimated cost.
   * @param {{ provider: string, model: string, operation: string, estimatedCost?: number }} entry
   */
  trackApiCall({ provider, model, operation, estimatedCost }) {
    const rateKey = `${provider}:${model}${operation ? ":" + operation : ""}`;
    const cost = typeof estimatedCost === "number"
      ? estimatedCost
      : (this.costRates[rateKey] ?? this.costRates[`${provider}:${model}`] ?? 0);

    const entry = {
      at: Date.now(),
      provider,
      model,
      operation: operation || "generate",
      estimatedCost: cost,
    };

    this.apiCalls.push(entry);
    if (this.apiCalls.length > this.maxApiCalls) {
      this.apiCalls.splice(0, this.apiCalls.length - this.maxApiCalls);
    }
  }

  getCostSummary() {
    const now = Date.now();
    const cutoff24h = now - 24 * 60 * 60 * 1000;
    const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;

    let totalCost = 0;
    let totalCalls = 0;
    let cost24h = 0;
    let calls24h = 0;
    let cost7d = 0;
    let calls7d = 0;

    const byProvider = {};
    const byModel = {};

    for (const call of this.apiCalls) {
      totalCost += call.estimatedCost;
      totalCalls += 1;

      if (call.at >= cutoff24h) {
        cost24h += call.estimatedCost;
        calls24h += 1;
      }
      if (call.at >= cutoff7d) {
        cost7d += call.estimatedCost;
        calls7d += 1;
      }

      const providerKey = call.provider;
      if (!byProvider[providerKey]) {
        byProvider[providerKey] = { calls: 0, estimatedCost: 0 };
      }
      byProvider[providerKey].calls += 1;
      byProvider[providerKey].estimatedCost += call.estimatedCost;

      const modelKey = `${call.provider}:${call.model}`;
      if (!byModel[modelKey]) {
        byModel[modelKey] = { provider: call.provider, model: call.model, calls: 0, estimatedCost: 0 };
      }
      byModel[modelKey].calls += 1;
      byModel[modelKey].estimatedCost += call.estimatedCost;
    }

    // Round costs to 4 decimal places
    const round = (v) => Math.round(v * 10000) / 10000;

    const breakdown = Object.values(byModel)
      .sort((a, b) => b.estimatedCost - a.estimatedCost)
      .map((item) => ({ ...item, estimatedCost: round(item.estimatedCost) }));

    return {
      totalCalls,
      totalEstimatedCost: round(totalCost),
      last24h: { calls: calls24h, estimatedCost: round(cost24h) },
      last7d: { calls: calls7d, estimatedCost: round(cost7d) },
      byProvider: Object.fromEntries(
        Object.entries(byProvider).map(([k, v]) => [k, { ...v, estimatedCost: round(v.estimatedCost) }])
      ),
      breakdown,
    };
  }

  /**
   * Persist cumulative counters to the data store so they survive restarts.
   * Stores under the special shop domain "_analytics".
   */
  _persist() {
    if (!this._settingsRepo) return;
    try {
      const snapshot = {
        totalRequests: this.totalRequests,
        uniqueVisitorCount: this.uniqueVisitors.size,
        pathCounts: Object.fromEntries(this.pathCounts),
        apiCalls: this.apiCalls.slice(-500), // keep last 500 for cost summary
        savedAt: Date.now(),
      };
      this._settingsRepo.upsertByShop("_analytics", { analyticsSnapshot: snapshot });
      // Don't flush on every persist — the normal write cycle handles it
    } catch (err) {
      log.warn({ err: err?.message }, "Failed to persist analytics snapshot");
    }
  }

  /**
   * Restore cumulative counters from the data store on startup.
   */
  _restore() {
    if (!this._settingsRepo) return;
    try {
      const record = this._settingsRepo.findByShop("_analytics");
      const snap = record?.analyticsSnapshot;
      if (!snap) return;

      this.totalRequests = snap.totalRequests || 0;
      // We can't restore the actual Set from a count, but we can set a baseline
      this._restoredVisitorCount = snap.uniqueVisitorCount || 0;
      if (snap.pathCounts) {
        for (const [k, v] of Object.entries(snap.pathCounts)) {
          this.pathCounts.set(k, v);
        }
      }
      if (Array.isArray(snap.apiCalls)) {
        this.apiCalls = snap.apiCalls;
      }
      log.info({ totalRequests: this.totalRequests, apiCalls: this.apiCalls.length }, "Restored analytics from DB");
    } catch (err) {
      log.warn({ err: err?.message }, "Failed to restore analytics snapshot");
    }
  }
}

module.exports = {
  AnalyticsService,
};
