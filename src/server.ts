import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import { products, getProduct } from "./catalog.js";
import { addToCart, removeFromCart, clearCart, viewCart } from "./cart.js";
import { placeOrder, getOrder } from "./orders.js";
import { isEnabled, getVariation, trackEvent } from "./flags.js";

const SESSION_COOKIE = "shopfront_session";
const CATEGORY_FILTER_FLAG = "enable-category-filter";
const PRICE_SORT_FLAG = "enable-price-sort";
const DISCOUNT_CODES_FLAG = "enable-discount-codes";

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

  app.get("/api/storefront", async (req, res) => {
    const showPromoBanner = await isEnabled("show-promo-banner", req.sessionId);
    const categoryFilter = (await getVariation(CATEGORY_FILTER_FLAG, req.sessionId, "control")) === "v1";
    const priceSort = (await getVariation(PRICE_SORT_FLAG, req.sessionId, "control")) === "v1";
    const discountCodes = (await getVariation(DISCOUNT_CODES_FLAG, req.sessionId, "control")) === "v1";
    res.json({
      name: "Shopfront",
      tagline: "Small-batch coffee and brew gear",
      promoBanner: showPromoBanner ? "Free shipping on orders over $40 this week." : null,
      categoryFilter,
      priceSort,
      discountCodes,
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
      const category = req.query.category;
      let list = products;
      if (categoryFilterVariation === "v1" && category !== undefined) {
        if (category !== "beans" && category !== "gear") {
          res.status(400).json({ error: "unknown category" });
          return;
        }
        list = products.filter((p) => p.category === category);
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
      res.json({ products: list });
      trackEvent("enable-category-filter-products-loaded", req.sessionId);
      // Guarded-release telemetry for enable-price-sort: emitted on BOTH the
      // control and v1 paths so the release can compare them. Never throws.
      trackEvent("enable-price-sort-products-loaded", req.sessionId);
    } catch (err) {
      trackEvent("enable-category-filter-error", req.sessionId);
      trackEvent("enable-price-sort-error", req.sessionId);
      throw err;
    } finally {
      const elapsedMs = performance.now() - startedAt;
      trackEvent("enable-category-filter-latency", req.sessionId, elapsedMs);
      trackEvent("enable-price-sort-latency", req.sessionId, elapsedMs);
    }
  });

  app.get("/api/products/:id", (req, res) => {
    const product = getProduct(req.params.id);
    if (!product) {
      res.status(404).json({ error: "product not found" });
      return;
    }
    res.json({ product });
  });

  app.get("/api/cart", (req, res) => {
    res.json(viewCart(req.sessionId));
  });

  app.post("/api/cart", (req, res) => {
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
    addToCart(req.sessionId, productId, qty);
    res.json(viewCart(req.sessionId));
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
      const order = placeOrder(cart, discount);
      clearCart(req.sessionId);
      res.status(201).json({ order });
      trackEvent("enable-discount-codes-order-placed", req.sessionId);
    } catch (err) {
      trackEvent("enable-discount-codes-error", req.sessionId);
      throw err;
    } finally {
      const elapsedMs = performance.now() - startedAt;
      trackEvent("enable-discount-codes-latency", req.sessionId, elapsedMs);
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
