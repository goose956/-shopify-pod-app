# POD Shopify App (Minimal MVP)

This repository contains a minimal implementation of a POD-focused Shopify app:

- `web/frontend`: Embedded React + Polaris UI
- `backend`: Express API for two-step POD generation and approval

The embedded app now includes two sections on the same screen:

- `Generator`: preview → revise → approve flow
- `Admin`: publish status + asset viewer + API key settings

## What this MVP does

1. Step 1: Merchant generates an initial product design preview.
2. Merchant can reject and request amendments to regenerate the preview.
3. Step 2: Merchant approves design, then backend generates lifestyle images + listing copy.
4. Backend creates Shopify product and returns `productId` and `adminUrl`.

## Project structure

```
backend/
  index.js
  src/
    config.js
    server.js
    routes/
      podRoutes.js
    repositories/
      designRepository.js
      assetRepository.js
      productRepository.js
    services/
      authService.js
      podPipelineService.js
      assetStorageService.js
      shopifyPublishService.js
    storage/
      jsonStore.js
  data/
    store.json (runtime generated)
web/frontend/
  index.html
  package.json
  vite.config.js
  src/
    main.jsx
    App.jsx
    pages/
      index.jsx
    components/
      ProductGenerator.jsx
      AdminDashboard.jsx
```

## Setup

1. Install dependencies:

   ```bash
   npm install
   npm --prefix web/frontend install
   ```

2. Create `.env` from `.env.example` and fill Shopify credentials.
  - For local UI preview, keep `ALLOW_DEV_BYPASS=true` so `dev-session-token` is accepted.

3. Run both services:

   ```bash
   npm run dev
   ```

Frontend runs on `http://localhost:5173` and backend on `http://localhost:3000` by default.

## Notes

- API endpoints are `POST /api/design-preview`, `POST /api/revise-design`, and `POST /api/finalize-product`.
- Admin endpoint is `GET /api/designs` (Shopify session token required).
- Settings endpoints are `GET /api/settings` and `PUT /api/settings` for KEI/OpenAI API keys.
- `backend/index.js` includes placeholder AI steps (artwork prompt/image/lifestyle/copy). Replace each with your real provider calls.
- To create real products, set `SHOPIFY_ADMIN_ACCESS_TOKEN`. If omitted, the backend returns a mock `productId` + admin products URL.
- In embedded Shopify context, replace frontend token acquisition with your App Bridge session-token flow.
