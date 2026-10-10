import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Flag-path tests for `enable-inventory-tracking` (string multivariate: "control" | "v1").
// The flags module is mocked so each test can force the variation the server sees.
// Inventory state is module-level, shared across app instances in this file's
// worker; control tests never touch stock, and the v1 tests below deliberately
// drain beans-decaf (initial stock 2) in order.
const mocks = vi.hoisted(() => ({
  getVariation: vi.fn(),
  isEnabled: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("../src/flags.js", () => ({
  getVariation: mocks.getVariation,
  isEnabled: mocks.isEnabled,
  trackEvent: mocks.trackEvent,
  contextForSession: (sessionId: string) => ({ kind: "user", key: sessionId }),
  closeFlags: async () => {},
}));

import { createApp } from "../src/server.js";

const FLAG = "enable-inventory-tracking";

function agent() {
  return request.agent(createApp());
}

function setVariation(value: string) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key === FLAG ? value : fallback,
  );
}

beforeEach(() => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
});

describe("enable-inventory-tracking: control (flag off)", () => {
  beforeEach(() => setVariation("control"));

  it("omits stock from product responses", async () => {
    const list = await agent().get("/api/products").expect(200);
    for (const p of list.body.products) expect(p).not.toHaveProperty("stock");
    const one = await agent().get("/api/products/gear-kettle").expect(200);
    expect(one.body.product).not.toHaveProperty("stock");
    expect(mocks.getVariation).toHaveBeenCalledWith(FLAG, expect.any(String), "control");
  });

  it("allows adding more than stock and checks out without a 409", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle", quantity: 50 }).expect(200);
    await session.post("/api/checkout").expect(201);
  });

  it("an unexpected variation behaves like control", async () => {
    setVariation("v2");
    const res = await agent().get("/api/products").expect(200);
    expect(res.body.products[0]).not.toHaveProperty("stock");
  });

  it("storefront reports inventoryTracking false", async () => {
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.inventoryTracking).toBe(false);
  });
});

describe("enable-inventory-tracking: v1 (flag on)", () => {
  beforeEach(() => setVariation("v1"));

  it("storefront reports inventoryTracking true", async () => {
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.inventoryTracking).toBe(true);
  });

  it("reports remaining stock on the product listing and detail", async () => {
    const res = await agent().get("/api/products").expect(200);
    const kettle = res.body.products.find((p: { id: string }) => p.id === "gear-kettle");
    expect(kettle.stock).toBe(10); // control checkout above did not decrement
    const one = await agent().get("/api/products/gear-kettle").expect(200);
    expect(one.body.product.stock).toBe(10);
  });

  it("rejects adding more than the remaining stock to the cart", async () => {
    await agent()
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
