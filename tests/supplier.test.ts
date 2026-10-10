import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { verifyStockWithSupplier, SupplierTimeoutError } from "../src/supplier.js";

function agent() {
  return request.agent(createApp());
}

const savedEnv = {
  delay: process.env.SUPPLIER_VERIFY_DELAY_MS,
  timeout: process.env.SUPPLIER_VERIFY_TIMEOUT_MS,
};

afterEach(() => {
  process.env.SUPPLIER_VERIFY_DELAY_MS = savedEnv.delay;
  process.env.SUPPLIER_VERIFY_TIMEOUT_MS = savedEnv.timeout;
});

describe("supplier stock verification", () => {
  it("resolves when the supplier responds within the timeout", async () => {
    await expect(
      verifyStockWithSupplier([{ productId: "gear-v60", quantity: 1 }]),
    ).resolves.toBeUndefined();
  });

  it("times out when the supplier is slower than the timeout", async () => {
    process.env.SUPPLIER_VERIFY_DELAY_MS = "10";
    process.env.SUPPLIER_VERIFY_TIMEOUT_MS = "0";
    await expect(
      verifyStockWithSupplier([{ productId: "gear-v60", quantity: 1 }]),
    ).rejects.toBeInstanceOf(SupplierTimeoutError);
  });

  it("checkout still succeeds when verification passes", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-filters" }).expect(200);
    await session.post("/api/checkout").expect(201);
  });

  it("checkout fails closed with a 503 and keeps the cart when verification times out", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-filters" }).expect(200);

    process.env.SUPPLIER_VERIFY_DELAY_MS = "10";
    process.env.SUPPLIER_VERIFY_TIMEOUT_MS = "0";
    const res = await session.post("/api/checkout").expect(503);
    expect(res.body.error).toMatch(/supplier/);
    expect(res.body.productId).toBe("gear-filters");

    process.env.SUPPLIER_VERIFY_DELAY_MS = "1";
    process.env.SUPPLIER_VERIFY_TIMEOUT_MS = "1000";
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines).toHaveLength(1);
  });
});
