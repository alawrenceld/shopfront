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

  // enable-price-sort defaults to "control" when flags are unconfigured:
  // the sort param is ignored and the catalog order is unchanged (pre-PR behavior).
  it("ignores the sort param on the control path", async () => {
    const all = await agent().get("/api/products").expect(200);
    const asc = await agent().get("/api/products?sort=price-asc").expect(200);
    const desc = await agent().get("/api/products?sort=price-desc").expect(200);
    expect(asc.body.products).toEqual(all.body.products);
    expect(desc.body.products).toEqual(all.body.products);
  });

  it("does not reject unknown sorts on the control path", async () => {
    await agent().get("/api/products?sort=alphabetical").expect(200);
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

  // enable-discount-codes defaults to "control" when flags are unconfigured:
  // discountCode is ignored entirely and orders are placed at full price (pre-PR behavior).
  // The v1 (discount applied) path is covered in tests/discount-codes.test.ts.
  it("ignores a valid discount code on the control path", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    const checkout = await session
      .post("/api/checkout")
      .send({ discountCode: "SAVE10" })
      .expect(201);
    expect(checkout.body.order.totalCents).toBe(5400);
    expect(checkout.body.order.discountCents).toBe(0);
    expect(checkout.body.order.discountCode).toBeUndefined();
  });

  it("does not reject an unknown discount code on the control path", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "beans-colombia" }).expect(200);
    await session.post("/api/checkout").send({ discountCode: "NOTACODE" }).expect(201);
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines).toEqual([]);
  });

  it("places an undiscounted order when no code is given", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    const checkout = await session.post("/api/checkout").expect(201);
    expect(checkout.body.order.discountCents).toBe(0);
    expect(checkout.body.order.totalCents).toBe(checkout.body.order.subtotalCents);
  });
});

describe("storefront", () => {
  it("serves storefront info with no promo when flags are unconfigured", async () => {
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.name).toBe("Shopfront");
    expect(res.body.promoBanner).toBeNull();
    expect(res.body.priceSort).toBe(false);
    expect(res.body.discountCodes).toBe(false);
  });
});
