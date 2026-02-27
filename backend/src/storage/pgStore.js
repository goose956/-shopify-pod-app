const { Pool } = require("pg");

const INITIAL_STORE = {
  designs: [],
  assets: [],
  products: [],
  settings: [],
  members: [],
};

/**
 * PostgreSQL-backed store that implements the same read()/write() interface
 * as JsonStore. Uses a single JSONB row in an `app_data` table.
 *
 * This is a drop-in replacement — all existing repository classes work
 * without any changes.
 *
 * For a high-concurrency production app you'd eventually migrate to proper
 * normalised tables, but this approach is correct, persistent, and far
 * better than an ephemeral JSON file.
 */
class PostgresStore {
  constructor(databaseUrl) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")
        ? false
        : { rejectUnauthorized: false },
    });

    // In-memory cache so synchronous read() works (repos call it synchronously)
    this._cache = { ...INITIAL_STORE };
    this._ready = false;
    this._initPromise = this._init();
  }

  async _init() {
    const client = await this.pool.connect();
    try {
      // Create table if not exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_data (
          id INTEGER PRIMARY KEY DEFAULT 1,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // Ensure a row exists
      await client.query(`
        INSERT INTO app_data (id, data)
        VALUES (1, $1::jsonb)
        ON CONFLICT (id) DO NOTHING;
      `, [JSON.stringify(INITIAL_STORE)]);

      // Load into cache
      const result = await client.query("SELECT data FROM app_data WHERE id = 1");
      if (result.rows.length > 0) {
        const parsed = result.rows[0].data;
        this._cache = {
          designs: Array.isArray(parsed.designs) ? parsed.designs : [],
          assets: Array.isArray(parsed.assets) ? parsed.assets : [],
          products: Array.isArray(parsed.products) ? parsed.products : [],
          settings: Array.isArray(parsed.settings) ? parsed.settings : [],
          members: Array.isArray(parsed.members) ? parsed.members : [],
        };
      }

      const settingsCount = this._cache.settings.filter(s => !s.shopDomain?.startsWith("_nonce:")).length;
      const hasTokens = this._cache.settings.some(s => Boolean(s.shopifyAccessToken));
      this._ready = true;
      console.log(`[PostgresStore] Connected and initialised. Settings entries: ${settingsCount}, hasTokens: ${hasTokens}`);
    } finally {
      client.release();
    }
  }

  /** Wait for the store to be ready. Call this during server startup. */
  async waitForReady() {
    await this._initPromise;
  }

  /**
   * Synchronous read — returns the in-memory cache.
   * Kept synchronous so existing repository classes work unchanged.
   */
  read() {
    return {
      designs: [...this._cache.designs],
      assets: [...this._cache.assets],
      products: [...this._cache.products],
      settings: [...this._cache.settings],
      members: [...this._cache.members],
    };
  }

  /**
   * Synchronous-looking write that updates cache immediately
   * and persists to PostgreSQL asynchronously.
   */
  write(nextState) {
    // Update cache immediately (so the next read() sees the change)
    this._cache = {
      designs: Array.isArray(nextState.designs) ? nextState.designs : [],
      assets: Array.isArray(nextState.assets) ? nextState.assets : [],
      products: Array.isArray(nextState.products) ? nextState.products : [],
      settings: Array.isArray(nextState.settings) ? nextState.settings : [],
      members: Array.isArray(nextState.members) ? nextState.members : [],
    };

    // Persist to PostgreSQL (fire and forget — errors are logged)
    this._persist().catch((err) => {
      console.error("[PostgresStore] Failed to persist:", err.message);
    });
  }

  async _persist() {
    await this.pool.query(
      "UPDATE app_data SET data = $1::jsonb, updated_at = NOW() WHERE id = 1",
      [JSON.stringify(this._cache)]
    );
  }

  /**
   * Explicitly flush the in-memory cache to PostgreSQL and AWAIT the result.
   * Use this whenever you must guarantee the data is persisted before
   * continuing (e.g. after storing an OAuth token).
   */
  async flush() {
    await this._persist();
  }

  /** Graceful shutdown. */
  async close() {
    await this.pool.end();
  }
}

module.exports = {
  PostgresStore,
};
