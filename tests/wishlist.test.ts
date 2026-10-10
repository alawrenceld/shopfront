import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { remainingStock, commitOrder } from "../src/inventory.js";

function agent() {
  return request.agent(createApp());
}

describe("wishlist", () => {
  it("starts empty for a new session", async () => {
    const res = await agent().get("/api/wishlist").expect(200);
    expect(res.body).toEqual({ items: [] });
  });

  it("adds, lists with current product details, and removes", async () => {
    const session = agent();
    const added = await session.post("/api/wishlist").send({ productId: "gear-kettle" }).expect(200);
    expect(added.body.items).toEqual([
      { productId: "gear-kettle", name: "Gooseneck Kettle", priceCents: 5400, category: "gear", inStock: true },
    ]);

    await session.post("/api/wishlist").send({ productId: "beans-colombia" }).expect(200);
    const list = await session.get("/api/wishlist").expect(200);
    expect(list.body.items.map((i: { productId: string }) => i.productId)).toEqual([
      "gear-kettle",
      "beans-colombia",
    ]);
    expect(list.body.items[1]).toEqual({
      productId: "beans-colombia",
      name: "Colombia Huila",
      priceCents: 1650,
      category: "beans",
      inStock: true,
    });

    const removed = await session.delete("/api/wishlist/gear-kettle").expect(200);
    expect(removed.body.items.map((i: { productId: string }) => i.productId)).toEqual(["beans-colombia"]);
    const after = await session.get("/api/wishlist").expect(200);
    expect(after.body).toEqual(removed.body);
  });

  it("treats a duplicate add as a successful no-op", async () => {
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "gear-v60" }).expect(200);
    const res = await session.post("/api/wishlist").send({ productId: "gear-v60" }).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productId).toBe("gear-v60");
  });

  it("404s on an unknown product ID and leaves the wishlist unchanged", async () => {
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "gear-v60" }).expect(200);
    const res = await session.post("/api/wishlist").send({ productId: "nope" }).expect(404);
    expect(res.body.error).toBe("product not found");
    const list = await session.get("/api/wishlist").expect(200);
    expect(list.body.items.map((i: { productId: string }) => i.productId)).toEqual(["gear-v60"]);
  });

  it("rejects a missing productId", async () => {
    const session = agent();
    const res = await session.post("/api/wishlist").send({}).expect(400);
    expect(res.body.error).toBe("productId is required");
  });

  it("succeeds when removing a product that is not in the wishlist", async () => {
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "gear-filters" }).expect(200);
    const res = await session.delete("/api/wishlist/gear-kettle").expect(200);
    expect(res.body.items.map((i: { productId: string }) => i.productId)).toEqual(["gear-filters"]);
    await agent().delete("/api/wishlist/nope").expect(200, { items: [] });
  });

  it("isolates wishlists between sessions", async () => {
    const a = agent();
    const b = agent();
    await a.post("/api/wishlist").send({ productId: "beans-ethiopia" }).expect(200);
    await b.post("/api/wishlist").send({ productId: "gear-filters" }).expect(200);

    const resA = await a.get("/api/wishlist").expect(200);
    const resB = await b.get("/api/wishlist").expect(200);
    expect(resA.body.items.map((i: { productId: string }) => i.productId)).toEqual(["beans-ethiopia"]);
    expect(resB.body.items.map((i: { productId: string }) => i.productId)).toEqual(["gear-filters"]);

    await b.delete("/api/wishlist/beans-ethiopia").expect(200);
    const stillA = await a.get("/api/wishlist").expect(200);
    expect(stillA.body.items).toHaveLength(1);
  });

  it("does not touch the cart or reserve stock", async () => {
    const session = agent();
    const before = remainingStock("gear-kettle");
    await session.post("/api/wishlist").send({ productId: "gear-kettle" }).expect(200);
    expect(remainingStock("gear-kettle")).toBe(before);
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines).toEqual([]);

    // Cart and checkout behave as before, and leave the wishlist alone.
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    await session.post("/api/checkout").expect(201);
    const list = await session.get("/api/wishlist").expect(200);
    expect(list.body.items.map((i: { productId: string }) => i.productId)).toEqual(["gear-kettle"]);
  });

  it("reports a product as out of stock once its remaining stock is gone", async () => {
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "beans-decaf" }).expect(200);
    // Inventory is module-level and isolated to this test file's worker.
    expect(commitOrder([{ productId: "beans-decaf", quantity: remainingStock("beans-decaf") }])).toEqual([]);
    const res = await session.get("/api/wishlist").expect(200);
    expect(res.body.items[0]).toMatchObject({ productId: "beans-decaf", inStock: false });
  });
});
