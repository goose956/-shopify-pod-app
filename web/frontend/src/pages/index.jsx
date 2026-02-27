import { Page } from "@shopify/polaris";
import { ProductGenerator } from "../components/ProductGenerator";

export default function HomePage() {
  return (
    <Page title="AI POD Product Generator" subtitle="Create AI-designed products and publish them to your Shopify store in minutes.">
      <ProductGenerator />
    </Page>
  );
}
