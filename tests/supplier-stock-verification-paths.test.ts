import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type express from "express";

// Flag-path tests for `enable-supplier-stock-verification` (string multivariate:
// "control" | "v1"). Covers the guarded-release telemetry on both arms, the
// per-line retry on v1, and that a v1 503 never decrements stock (with
// enable-inventory-tracking on v1). Basic 201/503 behavior lives in
// supplier.test.ts.
//
// Stock and carts are module-level state, so each test re-imports the server
// after vi.resetModules() to start from catalog stock.
const mocks = vi.hoisted(() => ({
  getVariation: vi.fn(),
  isEnabled: vi.fn(),
  trackEvent: vi.fn(),
  placeOrderShouldThrow: false,
}));

vi.mock("../src/flags.js", () => ({
  getVariation: mocks.getVariation,
  isEnabled: mocks.isEnabled,
  trackEvent: mocks.trackEvent,
  contextForSession: (sessionId: string) => ({ kind: "user", key: sessionId }),
  closeFlags: async () => {},
}));

vi.mock("../src/orders.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/orders.js")>();
  return {
    ...actual,
    placeOrder: (...args: Parameters<typeof actual.placeOrder>) => {
      if (mocks.placeOrderShouldThrow) throw new Error("boom");
      return actual.placeOrder(...args);
    },
  };
});

const FLAG = "enable-supplier-stock-verification";
const INVENTORY_FLAG = "enable-inventory-tracking";
const ORDER_PLACED = "enable-supplier-stock-verification-order-placed";
const ERROR = "enable-supplier-stock-verification-error";
const LATENCY = "enable-supplier-stock-verification-latency";

let app: express.Express;

function agent() {
  return request.agent(app);
}

function setVariations(variations: Record<string, string>) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key in variations ? variations[key] : fallback,
  );
}

function supplierEvents(): unknown[][] {
  return mocks.trackEvent.mock.calls.filter((c) => String(c[0]).startsWith(`${FLAG}-`));
}

function eventKeys(): string[] {
  return supplierEvents().map((c) => c[0] as string);
}

function forceSupplierTimeout() {
  process.env.SUPPLIER_VERIFY_DELAY_MS = "10";
  process.env.SUPPLIER_VERIFY_TIMEOUT_MS = "0";
}

function supplierFast() {
  process.env.SUPPLIER_VERIFY_DELAY_MS = "1";
  process.env.SUPPLIER_VERIFY_TIMEOUT_MS = "1000";
}

async function stockOf(productId: string): Promise<number> {
  const res = await agent().get(`/api/products/${productId}`).expect(200);
  return res.body.product.stock;
}

const savedEnv = {
  delay: process.env.SUPPLIER_VERIFY_DELAY_MS,
  timeout: process.env.SUPPLIER_VERIFY_TIMEOUT_MS,
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  mocks.placeOrderShouldThrow = false;
  supplierFast();
  vi.resetModules();
  const { createApp } = await import("../src/server.js");
  app = createApp();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv("SUPPLIER_VERIFY_DELAY_MS", savedEnv.delay);
  restoreEnv("SUPPLIER_VERIFY_TIMEOUT_MS", savedEnv.timeout);
});

describe.each(["control", "v1"])("enable-supplier-stock-verification telemetry (%s)", (variation) => {
  beforeEach(() => setVariations({ [FLAG]: variation }));

  it("successful checkout: order-placed + latency on the flag's session, no error", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    mocks.getVariation.mockClear();
    await session.post("/api/checkout").expect(201);

    const events = supplierEvents();
    expect(events.map((c) => c[0])).toEqual([ORDER_PLACED, LATENCY]);
    const flagSession = mocks.getVariation.mock.calls.find((c) => c[0] === FLAG)?.[1];
    expect(flagSession).toEqual(expect.any(String));
    for (const call of events) expect(call[1]).toBe(flagSession);
    const latency = events.find((c) => c[0] === LATENCY)!;
    expect(typeof latency[2]).toBe("number");
    expect(latency[2] as number).toBeGreaterThanOrEqual(0);
  });

  it("placeOrder throws: exactly one error + latency, no order-placed, 500", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    mocks.placeOrderShouldThrow = true;
    await session.post("/api/checkout").expect(500);

    expect(eventKeys()).toEqual([ERROR, LATENCY]);
  });

  it("empty cart 400: latency only", async () => {
    await agent().post("/api/checkout").expect(400);
    expect(eventKeys()).toEqual([LATENCY]);
  });
});

describe("enable-supplier-stock-verification: supplier timeout", () => {
  it("v1: 503 emits exactly one error + latency, no order-placed", async () => {
    setVariations({ [FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    forceSupplierTimeout();
    const res = await session.post("/api/checkout").expect(503);
    expect(res.body.productId).toBe("gear-kettle");
    expect(eventKeys()).toEqual([ERROR, LATENCY]);
  });

  it("control: the same slow supplier is never consulted — 201, order-placed + latency", async () => {
    setVariations({ [FLAG]: "control" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    forceSupplierTimeout();
    const random = vi.spyOn(Math, "random");
    await session.post("/api/checkout").expect(201);
    expect(random).not.toHaveBeenCalled();
    expect(eventKeys()).toEqual([ORDER_PLACED, LATENCY]);
  });
});

describe("enable-supplier-stock-verification: per-line retry", () => {
  // latency = delay * (0.5 + random); with delay = timeout = 10ms,
  // random 0.9 -> 14ms (timeout), random 0 -> 5ms (passes).
  beforeEach(() => {
    process.env.SUPPLIER_VERIFY_DELAY_MS = "10";
    process.env.SUPPLIER_VERIFY_TIMEOUT_MS = "10";
  });

  it("v1: first attempt times out, retry passes -> 201 and order-placed", async () => {
    setVariations({ [FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(0.9).mockReturnValueOnce(0);
    await session.post("/api/checkout").expect(201);
    expect(random).toHaveBeenCalledTimes(2);
    expect(eventKeys()).toEqual([ORDER_PLACED, LATENCY]);
  });

  it("v1: both attempts time out -> 503 (only one retry per line)", async () => {
    setVariations({ [FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
    await session.post("/api/checkout").expect(503);
    expect(random).toHaveBeenCalledTimes(2);
    expect(eventKeys()).toEqual([ERROR, LATENCY]);
  });

  it("v1: retries are per line — each line gets its own retry", async () => {
    setVariations({ [FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    await session.post("/api/cart").send({ productId: "beans-decaf" }).expect(200);
    const random = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0);
    await session.post("/api/checkout").expect(201);
    expect(random).toHaveBeenCalledTimes(4);
  });

  it("control: no supplier attempts at all, even when every attempt would time out", async () => {
    setVariations({ [FLAG]: "control" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
    await session.post("/api/checkout").expect(201);
    expect(random).not.toHaveBeenCalled();
  });
});

describe("enable-supplier-stock-verification: stock with enable-inventory-tracking on v1", () => {
  it("v1: a 503 decrements no stock and keeps the cart", async () => {
    setVariations({ [FLAG]: "v1", [INVENTORY_FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "beans-decaf", quantity: 2 }).expect(200);
    expect(await stockOf("beans-decaf")).toBe(2);
    forceSupplierTimeout();
    await session.post("/api/checkout").expect(503);
    supplierFast();
    expect(await stockOf("beans-decaf")).toBe(2);
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines).toEqual([expect.objectContaining({ productId: "beans-decaf", quantity: 2 })]);
  });

  it("v1: a later successful retry of the same cart then decrements stock once", async () => {
    setVariations({ [FLAG]: "v1", [INVENTORY_FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "beans-decaf", quantity: 2 }).expect(200);
    forceSupplierTimeout();
    await session.post("/api/checkout").expect(503);
    supplierFast();
    await session.post("/api/checkout").expect(201);
    expect(await stockOf("beans-decaf")).toBe(0);
  });

  it("control: the slow supplier is ignored and stock is decremented normally", async () => {
    setVariations({ [FLAG]: "control", [INVENTORY_FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "beans-decaf", quantity: 2 }).expect(200);
    forceSupplierTimeout();
    await session.post("/api/checkout").expect(201);
    expect(await stockOf("beans-decaf")).toBe(0);
  });
});
