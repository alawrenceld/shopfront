# Shopfront

A small e-commerce storefront selling small-batch coffee and brew gear: product
catalog, cart, and checkout. Single Express service with an in-memory store and
a static frontend.

## What this repository actually is

Shopfront is a **demo environment**, not a product. It exists so that
[LaunchDarkly's](https://launchdarkly.com) NextGen factory demo can show a real
software factory operating on a real codebase: every pull request here was
driven through an automated chain
([launchdarkly-auto-factory](https://github.com/launchdarkly-labs/launchdarkly-auto-factory))
that decides whether a change needs a feature flag, wires it, authors guardrail
metrics and tests, reviews the result, and releases it behind a guarded
rollout. The PR history, review verdicts, judge scores, and release records are
the demo's raw material — they are all real, which is the point.

Two things a reader should know:

- **One regression here is seeded on purpose.** PR [#6](../../pull/6)'s
  supplier stock-verification step (`src/supplier.ts`) adds real awaited
  latency to checkout and a real, tunable 503 rate (`SUPPLIER_VERIFY_DELAY_MS`
  / `SUPPLIER_VERIFY_TIMEOUT_MS`). It exists so a guarded rollout has a genuine
  regression to catch and roll back. The factory's reviewer independently
  caught (and its rework loop fixed) a real concurrency bug in that PR, but the
  regression's measurable badness is intact by design. Do not copy that pattern
  into a real checkout path.
- **The app is deliberately simple.** In-memory store, cookie sessions, no
  database, no auth — a legible stage for flag-gated changes, not a reference
  architecture.

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
| GET | `/api/wishlist` | Current session's wishlist, with each product's name, price, category, and `inStock` |
| POST | `/api/wishlist` | Add `{ productId }` to the wishlist (no-op if already present; 404 if unknown) |
| DELETE | `/api/wishlist/:productId` | Remove a product from the wishlist (no-op if absent) |
| POST | `/api/checkout` | Place an order from the cart |
| GET | `/api/orders/:id` | Look up an order |

Sessions are cookie-based; carts, wishlists, and orders live in memory.

## Feature flags

Flags are evaluated server-side through the helper in `src/flags.ts`, keyed on
the session. When LaunchDarkly is unreachable or unconfigured, every flag
evaluates to its off state and the store serves its default experience.
