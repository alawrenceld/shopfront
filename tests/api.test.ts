import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";

function agent() {
  return request.agent(createApp());
}

describe("products", () => {
  it("lists the catalog", async () => {
    const res = await agent().get("/api/products").expect(200);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.products[0]).toHaveProperty("priceCents");
  });

  it("returns a single product", async () => {
    const res = await agent().get("/api/products/beans-ethiopia").expect(200);
    expect(res.body.product.name).toBe("Ethiopia Yirgacheffe");
  });

  it("404s on an unknown product", async () => {
    await agent().get("/api/products/nope").expect(404);
  });

  // enable-category-filter defaults to "control" when flags are unconfigured:
  // the category param is ignored and the full catalog is returned (pre-PR behavior).
  it("ignores the category param on the control path", async () => {
    const all = await agent().get("/api/products").expect(200);
    const res = await agent().get("/api/products?category=gear").expect(200);
    expect(res.body.products).toEqual(all.body.products);
  });

  it("does not reject unknown categories on the control path", async () => {
    await agent().get("/api/products?category=snacks").expect(200);
  });
});

describe("cart", () => {
  it("starts empty", async () => {
    const res = await agent().get("/api/cart").expect(200);
    expect(res.body.lines).toEqual([]);
    expect(res.body.totalCents).toBe(0);
  });

  it("adds and accumulates items per session", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
    const res = await session
      .post("/api/cart")
      .send({ productId: "gear-v60", quantity: 2 })
      .expect(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].quantity).toBe(3);
    expect(res.body.totalCents).toBe(3 * 2800);
  });

  it("rejects unknown products and bad quantities", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "nope" }).expect(400);
    await session.post("/api/cart").send({ productId: "gear-v60", quantity: 0 }).expect(400);
  });

  it("removes items", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "beans-colombia" }).expect(200);
    const res = await session.delete("/api/cart/beans-colombia").expect(200);
    expect(res.body.lines).toEqual([]);
  });

  it("isolates carts between sessions", async () => {
    const a = agent();
    const b = agent();
    await a.post("/api/cart").send({ productId: "beans-decaf" }).expect(200);
    const res = await b.get("/api/cart").expect(200);
    expect(res.body.lines).toEqual([]);
  });
});

describe("checkout", () => {
  it("rejects an empty cart", async () => {
    await agent().post("/api/checkout").expect(400);
  });

  it("places an order and clears the cart", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    const checkout = await session.post("/api/checkout").expect(201);
    expect(checkout.body.order.totalCents).toBe(5400);

    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines).toEqual([]);

    const order = await session.get(`/api/orders/${checkout.body.order.id}`).expect(200);
    expect(order.body.order.id).toBe(checkout.body.order.id);
  });
});

describe("storefront", () => {
  it("serves storefront info with no promo when flags are unconfigured", async () => {
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.name).toBe("Shopfront");
    expect(res.body.promoBanner).toBeNull();
  });
});
