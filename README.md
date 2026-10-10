# Shopfront

A small e-commerce storefront selling small-batch coffee and brew gear: product
catalog, cart, and checkout. Single Express service with an in-memory store and
a static frontend.

## Stack

- Node 20+, TypeScript, Express 5
- LaunchDarkly server-side SDK for feature flags
- Vitest + supertest for API tests

## Running

```bash
npm install
npm run dev        # http://localhost:3000
```

Copy `.env.example` to `.env` to configure. `LD_SDK_KEY` is optional — without
it the app runs with all feature flags off.

## Tests

```bash
npm test
```

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/storefront` | Store name, tagline, and any active promo banner |
| GET | `/api/products` | List the catalog; `?q=` narrows to products whose name contains the query (case-insensitive) |
| GET | `/api/products/:id` | One product |
| GET | `/api/cart` | Current session's cart |
| POST | `/api/cart` | Add `{ productId, quantity? }` to the cart |
| DELETE | `/api/cart/:productId` | Remove a line |
| POST | `/api/checkout` | Place an order from the cart |
| GET | `/api/orders/:id` | Look up an order |

Sessions are cookie-based; carts and orders live in memory.

## Feature flags

Flags are evaluated server-side through the helper in `src/flags.ts`, keyed on
the session. When LaunchDarkly is unreachable or unconfigured, every flag
evaluates to its off state and the store serves its default experience.
