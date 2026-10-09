import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import { products, getProduct } from "./catalog.js";
import { addToCart, removeFromCart, clearCart, viewCart } from "./cart.js";
import { placeOrder, getOrder } from "./orders.js";
import { isEnabled } from "./flags.js";

const SESSION_COOKIE = "shopfront_session";

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
    res.json({
      name: "Shopfront",
      tagline: "Small-batch coffee and brew gear",
      promoBanner: showPromoBanner ? "Free shipping on orders over $40 this week." : null,
    });
  });

  app.get("/api/products", (_req, res) => {
    res.json({ products });
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

  app.post("/api/checkout", (req, res) => {
    const cart = viewCart(req.sessionId);
    if (cart.lines.length === 0) {
      res.status(400).json({ error: "cart is empty" });
      return;
    }
    const order = placeOrder(cart);
    clearCart(req.sessionId);
    res.status(201).json({ order });
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
