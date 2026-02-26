export async function getSessionToken() {
  if (window?.shopify?.idToken) {
    return window.shopify.idToken;
  }

  const storedToken = window.sessionStorage.getItem("shopify_session_token");
  if (storedToken) {
    return storedToken;
  }

  return "dev-session-token";
}
