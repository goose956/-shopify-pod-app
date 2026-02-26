import { Page } from "@shopify/polaris";
import { ProductGenerator } from "../components/ProductGenerator";

export default function HomePage() {
  return (
    <Page title="AI POD Product Generator">
      <ProductGenerator />
    </Page>
  );
}
