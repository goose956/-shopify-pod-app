/**
 * Retry a function with exponential backoff.
 *
 * @param {Function} fn        – Async function to retry
 * @param {object}   opts
 * @param {number}   opts.maxRetries   – Max retry attempts (default 3)
 * @param {number}   opts.baseDelayMs  – Base delay in ms (default 1000)
 * @param {Function} opts.shouldRetry  – Predicate: (error, attempt) => boolean
 * @param {string}   opts.label        – Log label for debugging
 * @returns {Promise<any>}
 */
async function retryWithBackoff(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    shouldRetry = defaultShouldRetry,
    label = "retryWithBackoff",
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !shouldRetry(err, attempt)) {
        throw err;
      }

      // Exponential backoff with jitter
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(
        `[${label}] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${err?.message || err}. Retrying in ${Math.round(delay)}ms…`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Default retry predicate: retry on network errors, 429, and 5xx.
 */
function defaultShouldRetry(err) {
  // Network / fetch errors
  if (err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT" || err?.code === "ENOTFOUND") {
    return true;
  }

  // HTTP status codes (when stored on error)
  const status = err?.status || err?.statusCode || 0;
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }

  // Match "429" or "5xx" in error message
  const msg = String(err?.message || "");
  if (/\b429\b/.test(msg) || /\b5\d{2}\b/.test(msg) || /rate.?limit/i.test(msg)) {
    return true;
  }

  return false;
}

module.exports = { retryWithBackoff };
