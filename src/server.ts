import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import { products, getProduct, searchByName, type Product } from "./catalog.js";
import { addToCart, removeFromCart, setQuantity, clearCart, viewCart, getCart, type CartLine } from "./cart.js";
import { remainingStock, commitOrder } from "./inventory.js";
import { placeOrder, getOrder } from "./orders.js";
import { verifyStockWithSupplier, SupplierTimeoutError } from "./supplier.js";
import { isEnabled, getVariation, trackEvent } from "./flags.js";

const SESSION_COOKIE = "shopfront_session";
const CATEGORY_FILTER_FLAG = "enable-category-filter";
const PRICE_SORT_FLAG = "enable-price-sort";
const DISCOUNT_CODES_FLAG = "enable-discount-codes";
const CART_QUANTITY_EDITING_FLAG = "enable-cart-quantity-editing";
const INVENTORY_TRACKING_FLAG = "enable-inventory-tracking";
const SUPPLIER_STOCK_VERIFICATION_FLAG = "enable-supplier-stock-verification";
const PRODUCT_SEARCH_FLAG = "enable-product-search";

/**
 * enable-inventory-tracking: shape a product for the API. Only the "v1"
 * variation reports `stock` (the live remaining stock). On control (or any
 * other value) the catalog's `stock` field is stripped so responses match the
 * pre-PR contract exactly.
 */
function toApiProduct(product: Product, inventoryVariation: string): Omit<Product, "stock"> & { stock?: number } {
  if (inventoryVariation === "v1") {
    return { ...product, stock: remainingStock(product.id) };
  }
  const { stock: _stock, ...rest } = product;
  return rest;
}

/**
 * enable-supplier-stock-verification: true when two carts hold exactly the same
 * product quantities (order-insensitive). Used on "v1" to detect a cart that
 * changed while checkout was awaiting the supplier.
 */
function sameCartLines(a: CartLine[], b: CartLine[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line) => b.some((other) => other.productId === line.productId && other.quantity === line.quantity));
}

// Percentage-off discount codes, applied to the cart subtotal at checkout.
const DISCOUNT_CODES: Record<string, number> = {
  SAVE10: 0.1,
};

declare global {
  namespace Express {
    interface Request {
      sessionId: string;
    }
  }
}

export function createApp(): express.Express {
  const app = express();
  // enable-supplier-stock-verification ("v1" only): sessions with a checkout
  // currently awaiting supplier verification. Control never touches this.
  const checkoutsInFlight = new Set<string>();
  app.use(express.json());
  app.use(cookieParser());

  app.use((req: Request, res: Response, next: NextFunction) => {
    let sessionId = req.cookies[SESSION_COOKIE] as string | undefined;
    if (!sessionId) {
      sessionId = randomUUID();
      res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: "lax" });
    }
    req.sessionId = sessionId;
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/status", (_req, res) => {
    res.json({ ok: true, version: process.env.GIT_SHA ?? "dev" });
  });

  app.get("/api/storefront", async (req, res) => {
    const showPromoBanner = await isEnabled("show-promo-banner", req.sessionId);
    const categoryFilter = (await getVariation(CATEGORY_FILTER_FLAG, req.sessionId, "control")) === "v1";
    const priceSort = (await getVariation(PRICE_SORT_FLAG, req.sessionId, "control")) === "v1";
    const discountCodes = (await getVariation(DISCOUNT_CODES_FLAG, req.sessionId, "control")) === "v1";
    const cartQuantityEditing =
      (await getVariation(CART_QUANTITY_EDITING_FLAG, req.sessionId, "control")) === "v1";
    const inventoryTracking =
      (await getVariation(INVENTORY_TRACKING_FLAG, req.sessionId, "control")) === "v1";
    const supplierStockVerification =
      (await getVariation(SUPPLIER_STOCK_VERIFICATION_FLAG, req.sessionId, "control")) === "v1";
    const productSearch = (await getVariation(PRODUCT_SEARCH_FLAG, req.sessionId, "control")) === "v1";
    res.json({
      name: "Shopfront",
      tagline: "Small-batch coffee and brew gear",
      promoBanner: showPromoBanner ? "Free shipping on orders over $40 this week." : null,
      categoryFilter,
      priceSort,
      discountCodes,
      cartQuantityEditing,
      inventoryTracking,
      supplierStockVerification,
      productSearch,
    });
  });

  app.get("/api/products", async (req, res) => {
    // Guarded-release telemetry for enable-category-filter: emitted on BOTH the
    // control and v1 paths (same session context as the flag) so the release
    // can compare them. trackEvent never throws; behavior is unchanged.
    const startedAt = performance.now();
    try {
      const categoryFilterVariation = await getVariation(CATEGORY_FILTER_FLAG, req.sessionId, "control");
      const priceSortVariation = await getVariation(PRICE_SORT_FLAG, req.sessionId, "control");
      const inventoryVariation = await getVariation(INVENTORY_TRACKING_FLAG, req.sessionId, "control");
      const productSearchVariation = await getVariation(PRODUCT_SEARCH_FLAG, req.sessionId, "control");
      const category = req.query.category;
      let list = products;
      if (categoryFilterVariation === "v1" && category !== undefined) {
        if (category !== "beans" && category !== "gear") {
          res.status(400).json({ error: "unknown category" });
          return;
        }
        list = products.filter((p) => p.category === category);
      }
      // enable-product-search: only the "v1" variation honors ?q= — narrowing to
      // products whose name contains the query (case-insensitive, trimmed;
      // empty/whitespace-only matches everything). On control the param is
      // ignored entirely (no validation, no 400) — pre-PR behavior.
      const q = req.query.q;
      if (productSearchVariation === "v1" && q !== undefined) {
        if (typeof q !== "string") {
          res.status(400).json({ error: "invalid search query" });
          return;
        }
        list = searchByName(list, q);
      }
      // enable-price-sort: only the "v1" variation honors ?sort=; on control the
      // param is ignored entirely (no validation, no 400) — pre-PR behavior.
      const sort = req.query.sort;
      if (priceSortVariation === "v1" && sort !== undefined) {
        if (sort !== "price-asc" && sort !== "price-desc") {
          res.status(400).json({ error: "unknown sort" });
          return;
        }
        const direction = sort === "price-asc" ? 1 : -1;
        list = [...list].sort((a, b) => direction * (a.priceCents - b.priceCents));
      }
      res.json({ products: list.map((p) => toApiProduct(p, inventoryVariation)) });
      trackEvent("enable-category-filter-products-loaded", req.sessionId);
      // Guarded-release telemetry for enable-price-sort: emitted on BOTH the
      // control and v1 paths so the release can compare them. Never throws.
      trackEvent("enable-price-sort-products-loaded", req.sessionId);
      // Guarded-release telemetry for enable-product-search: emitted on BOTH the
      // control and v1 paths so the release can compare them. Never throws.
      trackEvent("enable-product-search-products-loaded", req.sessionId);
    } catch (err) {
      trackEvent("enable-category-filter-error", req.sessionId);
      trackEvent("enable-price-sort-error", req.sessionId);
      // enable-inventory-tracking shapes every product (toApiProduct) on both arms.
      trackEvent("enable-inventory-tracking-error", req.sessionId);
      trackEvent("enable-product-search-error", req.sessionId);
      throw err;
    } finally {
      const elapsedMs = performance.now() - startedAt;
      trackEvent("enable-category-filter-latency", req.sessionId, elapsedMs);
      trackEvent("enable-price-sort-latency", req.sessionId, elapsedMs);
      trackEvent("enable-product-search-latency", req.sessionId, elapsedMs);
    }
  });

  app.get("/api/products/:id", async (req, res) => {
    const product = getProduct(req.params.id);
    if (!product) {
      res.status(404).json({ error: "product not found" });
      return;
    }
    const inventoryVariation = await getVariation(INVENTORY_TRACKING_FLAG, req.sessionId, "control");
    res.json({ product: toApiProduct(product, inventoryVariation) });
  });

  app.get("/api/cart", (req, res) => {
    res.json(viewCart(req.sessionId));
  });

  app.post("/api/cart", async (req, res) => {
    const { productId, quantity } = req.body ?? {};
    const qty = Number.isInteger(quantity) ? (quantity as number) : 1;
    if (typeof productId !== "string" || !getProduct(productId)) {
      res.status(400).json({ error: "unknown productId" });
      return;
    }
    if (qty < 1 || qty > 99) {
      res.status(400).json({ error: "quantity must be between 1 and 99" });
      return;
    }
    // enable-inventory-tracking: only "v1" validates against remaining stock;
    // control adds without any stock check (pre-PR behavior).
    const inventoryVariation = await getVariation(INVENTORY_TRACKING_FLAG, req.sessionId, "control");
    if (inventoryVariation === "v1") {
      const inCart = getCart(req.sessionId).find((l) => l.productId === productId)?.quantity ?? 0;
      if (inCart + qty > remainingStock(productId)) {
        res.status(400).json({ error: "insufficient stock" });
        return;
      }
    }
    addToCart(req.sessionId, productId, qty);
    res.json(viewCart(req.sessionId));
  });

  app.patch("/api/cart/:productId", async (req, res) => {
    // Guarded-release telemetry for enable-cart-quantity-editing: error and
    // latency are emitted on BOTH the control and v1 paths (same session context
    // as the flag) so the release can compare them. trackEvent never throws.
    const startedAt = performance.now();
    try {
      // enable-cart-quantity-editing: only the "v1" variation exposes this route.
      // On control (or any other value) it behaves as if it does not exist — a
      // 404 before any validation, cart untouched — which is pre-PR behavior.
      const variation = await getVariation(CART_QUANTITY_EDITING_FLAG, req.sessionId, "control");
      if (variation !== "v1") {
        res.status(404).json({ error: "not found" });
        return;
      }
      const { quantity } = req.body ?? {};
      if (!getProduct(req.params.productId)) {
        res.status(400).json({ error: "unknown productId" });
        return;
      }
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
        res.status(400).json({ error: "quantity must be between 0 and 99" });
        return;
      }
      // enable-inventory-tracking: evaluated independently of quantity editing;
      // only "v1" caps the new quantity at remaining stock.
      const inventoryVariation = await getVariation(INVENTORY_TRACKING_FLAG, req.sessionId, "control");
      if (inventoryVariation === "v1" && quantity > remainingStock(req.params.productId)) {
        res.status(400).json({ error: "insufficient stock" });
        return;
      }
      setQuantity(req.sessionId, req.params.productId, quantity);
      res.json(viewCart(req.sessionId));
      trackEvent("enable-cart-quantity-editing-quantity-updated", req.sessionId);
    } catch (err) {
      trackEvent("enable-cart-quantity-editing-error", req.sessionId);
      throw err;
    } finally {
      const elapsedMs = performance.now() - startedAt;
      trackEvent("enable-cart-quantity-editing-latency", req.sessionId, elapsedMs);
    }
  });

  app.delete("/api/cart/:productId", (req, res) => {
    removeFromCart(req.sessionId, req.params.productId);
    res.json(viewCart(req.sessionId));
  });

  app.post("/api/checkout", async (req, res) => {
    // Guarded-release telemetry for enable-discount-codes: emitted on BOTH the
    // control and v1 paths (same session context as the flag) so the release
    // can compare them. trackEvent never throws; behavior is unchanged.
    const startedAt = performance.now();
    // enable-supplier-stock-verification ("v1" only): set once this request owns
    // the session's in-flight checkout slot; released in `finally`.
    let holdsCheckoutSlot = false;
    try {
      const cart = viewCart(req.sessionId);
      if (cart.lines.length === 0) {
        res.status(400).json({ error: "cart is empty" });
        return;
      }
      // enable-discount-codes: only the "v1" variation honors discountCode; on
      // control (or any other value) the field is ignored entirely (no validation,
      // no 400) and the order is placed at full price — pre-PR behavior.
      const discountCodesVariation = await getVariation(DISCOUNT_CODES_FLAG, req.sessionId, "control");
      const { discountCode } = req.body ?? {};
      let discount;
      if (discountCodesVariation === "v1" && discountCode !== undefined && discountCode !== "") {
        if (typeof discountCode !== "string") {
          res.status(400).json({ error: "invalid discount code" });
          return;
        }
        const code = discountCode.trim().toUpperCase();
        const rate = DISCOUNT_CODES[code];
        if (rate === undefined) {
          res.status(400).json({ error: "invalid discount code" });
          return;
        }
        discount = { code, discountCents: Math.round(cart.totalCents * rate) };
      }
      // enable-supplier-stock-verification: only "v1" verifies each cart line
      // against the supplier feed and fails closed with a 503 (nothing
      // decremented, cart kept) on a supplier timeout. Control (or any other
      // value) never calls the supplier and goes straight on (pre-PR behavior).
      const supplierVariation = await getVariation(SUPPLIER_STOCK_VERIFICATION_FLAG, req.sessionId, "control");
      if (supplierVariation === "v1") {
        // Verification is slow, so one checkout per session at a time: a second
        // request (e.g. a double-click) is refused instead of placing a
        // duplicate order. Check-and-claim is synchronous, so it is race-free.
        if (checkoutsInFlight.has(req.sessionId)) {
          res.status(409).json({ error: "a checkout is already in progress for this cart" });
          return;
        }
        checkoutsInFlight.add(req.sessionId);
        holdsCheckoutSlot = true;
        try {
          await verifyStockWithSupplier(cart.lines);
        } catch (err) {
          if (err instanceof SupplierTimeoutError) {
            // A fail-closed refusal is an error for this flag's guardrail.
            trackEvent("enable-supplier-stock-verification-error", req.sessionId);
            res.status(503).json({
              error: "could not verify stock with the supplier — please try again",
              productId: err.productId,
            });
            return;
          }
          throw err;
        }
      }
      // enable-inventory-tracking: only "v1" commits the order against stock
      // (409 + shortages on oversell, nothing decremented). Control never reads
      // or decrements stock and goes straight to placeOrder (pre-PR behavior).
      const inventoryVariation = await getVariation(INVENTORY_TRACKING_FLAG, req.sessionId, "control");
      // enable-supplier-stock-verification ("v1" only): the cart may have been
      // edited while we awaited the supplier. Re-read it after the last await so
      // the check -> commitOrder -> placeOrder -> clearCart run is synchronous;
      // if it changed, nothing is ordered or decremented and the cart is kept.
      if (supplierVariation === "v1" && !sameCartLines(cart.lines, viewCart(req.sessionId).lines)) {
        res.status(409).json({ error: "your cart changed during checkout — please review it and try again" });
        return;
      }
      if (inventoryVariation === "v1") {
        const shortages = commitOrder(cart.lines);
        if (shortages.length > 0) {
          res.status(409).json({ error: "insufficient stock", shortages });
          return;
        }
      }
      const order = placeOrder(cart, discount);
      clearCart(req.sessionId);
      res.status(201).json({ order });
      trackEvent("enable-discount-codes-order-placed", req.sessionId);
      // Guarded-release telemetry for enable-inventory-tracking: emitted on BOTH
      // the control and v1 paths so the release can compare them. Never throws.
      trackEvent("enable-inventory-tracking-order-placed", req.sessionId);
      // Guarded-release telemetry for enable-supplier-stock-verification: emitted
      // on BOTH the control and v1 paths so the release can compare them.
      trackEvent("enable-supplier-stock-verification-order-placed", req.sessionId);
    } catch (err) {
      trackEvent("enable-discount-codes-error", req.sessionId);
      trackEvent("enable-inventory-tracking-error", req.sessionId);
      trackEvent("enable-supplier-stock-verification-error", req.sessionId);
      throw err;
    } finally {
      if (holdsCheckoutSlot) checkoutsInFlight.delete(req.sessionId);
      const elapsedMs = performance.now() - startedAt;
      trackEvent("enable-discount-codes-latency", req.sessionId, elapsedMs);
      trackEvent("enable-inventory-tracking-latency", req.sessionId, elapsedMs);
      trackEvent("enable-supplier-stock-verification-latency", req.sessionId, elapsedMs);
    }
  });

  app.get("/api/orders/:id", (req, res) => {
    const order = getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    res.json({ order });
  });

  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  app.use(express.static(publicDir));

  return app;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`shopfront listening on http://localhost:${port}`);
  });
}
