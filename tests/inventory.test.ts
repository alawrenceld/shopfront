import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";

// Inventory state is module-level, shared across app instances in this file's
// worker; tests below are written to be order-independent except where they
// deliberately drain beans-decaf (initial stock 2).

function agent() {
  return request.agent(createApp());
}

describe("inventory", () => {
  it("reports remaining stock on the product listing", async () => {
    const res = await agent().get("/api/products").expect(200);
    const kettle = res.body.products.find((p: { id: string }) => p.id === "gear-kettle");
    expect(kettle.stock).toBeGreaterThan(0);
  });

  it("rejects adding more than the remaining stock to the cart", async () => {
    const session = agent();
    await session
      .post("/api/cart")
      .send({ productId: "gear-v60", quantity: 99 })
      .expect(400)
      .expect((res) => {
        expect(res.body.error).toBe("insufficient stock");
      });
  });

  it("counts what is already in the cart against stock", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "beans-decaf", quantity: 1 }).expect(200);
    await session.post("/api/cart").send({ productId: "beans-decaf", quantity: 2 }).expect(400);
  });

  it("decrements stock on checkout and 409s an oversell, keeping the cart", async () => {
    const early = agent();
    await early.post("/api/cart").send({ productId: "beans-decaf", quantity: 2 }).expect(200);

    const late = agent();
    await late.post("/api/cart").send({ productId: "beans-decaf", quantity: 1 }).expect(200);
    await late.post("/api/checkout").expect(201);

    const products = await agent().get("/api/products").expect(200);
    const decaf = products.body.products.find((p: { id: string }) => p.id === "beans-decaf");
    expect(decaf.stock).toBe(1);

    const oversell = await early.post("/api/checkout").expect(409);
    expect(oversell.body.shortages).toEqual([
      { productId: "beans-decaf", requested: 2, available: 1 },
    ]);

    const cart = await early.get("/api/cart").expect(200);
    expect(cart.body.lines).toHaveLength(1);
  });
});
