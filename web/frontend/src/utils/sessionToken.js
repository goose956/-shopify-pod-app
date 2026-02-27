/**
 * Get a Shopify session token for authenticating API requests.
 * In production (embedded in Shopify admin), uses App Bridge.
 * In development, falls back to dev-session-token.
 */
export async function getSessionToken() {
  // App Bridge v4: window.shopify.idToken() returns a promise
  if (window?.shopify?.idToken) {
    try {
      const token = await window.shopify.idToken();
      if (token) return token;
    } catch {
      // Fall through to dev fallback
    }
  }

  // Legacy: check sessionStorage (e.g. member auth token)
  const storedToken = window.sessionStorage.getItem("shopify_session_token");
  if (storedToken) {
    return storedToken;
  }

  // Dev fallback — only works when ALLOW_DEV_BYPASS=true on backend
  return "dev-session-token";
}
