import { AppProvider as PolarisProvider, Frame } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import Pages from "./pages";

export default function App() {
  return (
    <PolarisProvider i18n={enTranslations}>
      <Frame>
        <Pages />
      </Frame>
    </PolarisProvider>
  );
}

// Note: Shopify App Bridge v4 auto-initialises via the CDN script in index.html.
// Session tokens are obtained via window.shopify.idToken() — see utils/sessionToken.js.
