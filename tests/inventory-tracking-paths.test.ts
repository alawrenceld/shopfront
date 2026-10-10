import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type express from "express";

// Flag-path tests for `enable-inventory-tracking` (string multivariate:
// "control" | "v1"), covering the guarded-release telemetry on both arms plus
// the v1 stock paths not covered in inventory.test.ts (PATCH over stock,
// partial-shortage multi-line checkout).
//
// Stock and carts are module-level state. Every test re-imports the server
// after vi.resetModules() so each one starts from the catalog's initial stock
// (e.g. beans-decaf = 2, gear-kettle = 10), whatever order the tests run in.
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

// Pass-through orders module with a switch to force an unexpected failure.
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

const FLAG = "enable-inventory-tracking";
const QTY_FLAG = "enable-cart-quantity-editing";
const CATEGORY_FLAG = "enable-category-filter";
const ORDER_PLACED = "enable-inventory-tracking-order-placed";
const ERROR = "enable-inventory-tracking-error";
const LATENCY = "enable-inventory-tracking-latency";

let app: express.Express;

function agent() {
  return request.agent(app);
}

function setVariations(variations: Record<string, string>) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key in variations ? variations[key] : fallback,
  );
}

// Scoped to this flag's events: other flags emit telemetry from the same handlers.
function inventoryEvents(): unknown[][] {
  return mocks.trackEvent.mock.calls.filter((c) => String(c[0]).startsWith("enable-inventory-tracking-"));
}

function eventKeys(): string[] {
  return inventoryEvents().map((c) => c[0] as string);
}

async function stockOf(productId: string): Promise<number> {
  const res = await agent().get(`/api/products/${productId}`).expect(200);
  return res.body.product.stock;
}

beforeEach(async () => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  mocks.placeOrderShouldThrow = false;
  vi.resetModules();
  const { createApp } = await import("../src/server.js");
  app = createApp();
});

describe.each(["control", "v1"])("enable-inventory-tracking telemetry (%s)", (variation) => {
  beforeEach(() => setVariations({ [FLAG]: variation }));

  it("successful checkout: order-placed + latency on the flag's session, no error", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    mocks.getVariation.mockClear();
    await session.post("/api/checkout").expect(201);

    const events = inventoryEvents();
    expect(events.map((c) => c[0])).toEqual([ORDER_PLACED, LATENCY]);
    const flagSession = mocks.getVariation.mock.calls.find((c) => c[0] === FLAG)?.[1];
    expect(flagSession).toEqual(expect.any(String));
    for (const call of events) expect(call[1]).toBe(flagSession);
    const latency = events.find((c) => c[0] === LATENCY)!;
    expect(typeof latency[2]).toBe("number");
    expect(latency[2] as number).toBeGreaterThanOrEqual(0);
  });

  it("placeOrder throws: error + latency, no order-placed, 500", async () => {
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

  it("products route failure: error event, 500", async () => {
    // Fail upstream of the inventory shaping, identically on both arms.
    mocks.getVariation.mockImplementation(async (key: string, _s: string, fallback = "control") => {
      if (key === CATEGORY_FLAG) throw new Error("flag store down");
      return key === FLAG ? variation : fallback;
    });
    await agent().get("/api/products").expect(500);
    expect(eventKeys()).toEqual([ERROR]);
  });

  it("successful products listing emits no inventory error", async () => {
    await agent().get("/api/products").expect(200);
    expect(eventKeys()).toEqual([]);
  });
});

describe("enable-inventory-tracking telemetry: oversell", () => {
  it("v1: 409 oversell emits latency only (not an order, not an error)", async () => {
    setVariations({ [FLAG]: "v1" });
    const early = agent();
    await early.post("/api/cart").send({ productId: "beans-decaf", quantity: 2 }).expect(200);
    const late = agent();
    await late.post("/api/cart").send({ productId: "beans-decaf", quantity: 1 }).expect(200);
    await late.post("/api/checkout").expect(201);

    mocks.trackEvent.mockClear();
    await early.post("/api/checkout").expect(409);
    expect(eventKeys()).toEqual([LATENCY]);
  });

  it("control: same carts both check out and both count as orders", async () => {
    setVariations({ [FLAG]: "control" });
    const early = agent();
    await early.post("/api/cart").send({ productId: "beans-decaf", quantity: 2 }).expect(200);
    const late = agent();
    await late.post("/api/cart").send({ productId: "beans-decaf", quantity: 1 }).expect(200);
    await late.post("/api/checkout").expect(201);

    mocks.trackEvent.mockClear();
    await early.post("/api/checkout").expect(201);
    expect(eventKeys()).toEqual([ORDER_PLACED, LATENCY]);
  });
});

describe("enable-inventory-tracking: stock isolation between tests", () => {
  it("each test starts from catalog stock (v1 drains decaf)", async () => {
    setVariations({ [FLAG]: "v1" });
    expect(await stockOf("beans-decaf")).toBe(2);
    const s = agent();
    await s.post("/api/cart").send({ productId: "beans-decaf", quantity: 2 }).expect(200);
    await s.post("/api/checkout").expect(201);
    expect(await stockOf("beans-decaf")).toBe(0);
  });

  it("...and the next test sees decaf restored", async () => {
    setVariations({ [FLAG]: "v1" });
    expect(await stockOf("beans-decaf")).toBe(2);
  });
});

describe("enable-inventory-tracking: PATCH /api/cart/:productId (quantity editing on v1)", () => {
  it("v1: PATCH above remaining stock is rejected and the cart is unchanged", async () => {
    setVariations({ [FLAG]: "v1", [QTY_FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    const res = await session.patch("/api/cart/gear-kettle").send({ quantity: 11 }).expect(400);
    expect(res.body.error).toBe("insufficient stock");
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines).toEqual([expect.objectContaining({ productId: "gear-kettle", quantity: 1 })]);
  });

  it("v1: PATCH exactly to remaining stock is allowed", async () => {
    setVariations({ [FLAG]: "v1", [QTY_FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    await session.patch("/api/cart/gear-kettle").send({ quantity: 10 }).expect(200);
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines[0].quantity).toBe(10);
  });

  it("control: PATCH above stock is allowed (no stock cap)", async () => {
    setVariations({ [FLAG]: "control", [QTY_FLAG]: "v1" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    await session.patch("/api/cart/gear-kettle").send({ quantity: 50 }).expect(200);
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines[0].quantity).toBe(50);
  });
});

describe("enable-inventory-tracking: multi-line checkout with a partial shortage", () => {
  async function setup() {
    const buyer = agent();
    await buyer.post("/api/cart").send({ productId: "gear-kettle", quantity: 3 }).expect(200);
    await buyer.post("/api/cart").send({ productId: "beans-decaf", quantity: 2 }).expect(200);
    const rival = agent();
    await rival.post("/api/cart").send({ productId: "beans-decaf", quantity: 1 }).expect(200);
    await rival.post("/api/checkout").expect(201);
    return buyer;
  }

  it("v1: 409 lists only the short line and decrements nothing", async () => {
    setVariations({ [FLAG]: "v1" });
    const buyer = await setup();
    const res = await buyer.post("/api/checkout").expect(409);
    expect(res.body.shortages).toEqual([{ productId: "beans-decaf", requested: 2, available: 1 }]);
    expect(await stockOf("gear-kettle")).toBe(10);
    expect(await stockOf("beans-decaf")).toBe(1);
    const cart = await buyer.get("/api/cart").expect(200);
    expect(cart.body.lines).toHaveLength(2);
  });

  it("control: the same multi-line order is placed and stock is never touched", async () => {
    setVariations({ [FLAG]: "control" });
    const buyer = await setup();
    const res = await buyer.post("/api/checkout").expect(201);
    expect(res.body.order).toBeDefined();
    const cart = await buyer.get("/api/cart").expect(200);
    expect(cart.body.lines).toHaveLength(0);
    // Switch the read to v1 to inspect stock: control never decremented it.
    setVariations({ [FLAG]: "v1" });
    expect(await stockOf("gear-kettle")).toBe(10);
    expect(await stockOf("beans-decaf")).toBe(2);
  });
});
