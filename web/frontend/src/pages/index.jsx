import { Page } from "@shopify/polaris";
import { ProductGenerator } from "../components/ProductGenerator";

export default function HomePage() {
  return (
    <Page title="ListingLab" subtitle="Create AI-designed print-on-demand products and publish them to your store in minutes.">
      <ProductGenerator />
    </Page>
  );
}
