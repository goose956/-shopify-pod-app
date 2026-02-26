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
