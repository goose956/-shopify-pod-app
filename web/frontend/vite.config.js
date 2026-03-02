import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Replace %SHOPIFY_API_KEY% in index.html at build time
function injectApiKey() {
  return {
    name: "inject-shopify-api-key",
    transformIndexHtml(html) {
      return html.replace(
        /%SHOPIFY_API_KEY%/g,
        process.env.SHOPIFY_API_KEY || ""
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), injectApiKey()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
