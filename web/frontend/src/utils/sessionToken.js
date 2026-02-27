/**
 * Get a Shopify session token for authenticating API requests.
 * Priority: App Bridge → setup secret (from URL ?setup=xxx) → sessionStorage → dev fallback.
 */
export async function getSessionToken() {
  // App Bridge v4: window.shopify.idToken() returns a promise
  if (window?.shopify?.idToken) {
    try {
      const token = await window.shopify.idToken();
      if (token) return token;
    } catch {
      // Fall through to other methods
    }
  }

  // Setup secret — passed via ?setup=SECRET in the URL, then persisted.
  // Allows admin access before Shopify OAuth is complete.
  const params = new URLSearchParams(window.location.search);
  const setupParam = params.get("setup");
  if (setupParam) {
    window.sessionStorage.setItem("setup_secret", setupParam);
    // Clean the URL so the secret isn't visible
    const clean = new URL(window.location);
    clean.searchParams.delete("setup");
    window.history.replaceState({}, "", clean);
  }
  const setupSecret = window.sessionStorage.getItem("setup_secret");
  if (setupSecret) {
    return setupSecret;
  }

  // Legacy: check sessionStorage (e.g. member auth token)
  const storedToken = window.sessionStorage.getItem("shopify_session_token");
  if (storedToken) {
    return storedToken;
  }

  // Dev fallback — only works when ALLOW_DEV_BYPASS=true on backend
  return "dev-session-token";
}
