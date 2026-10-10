import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Flag-path tests for the guarded-release telemetry on POST /api/checkout behind
// `enable-discount-codes` (string multivariate: "control" | "v1"). Every case is
// run on BOTH arms so the control-vs-v1 metric comparison stays valid.
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

// Pass-through orders module with a switch to force an unexpected failure,
// which exercises the handler's catch (error event) path.
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

import { createApp } from "../src/server.js";

const FLAG = "enable-discount-codes";
const ORDER_PLACED = "enable-discount-codes-order-placed";
const ERROR = "enable-discount-codes-error";
const LATENCY = "enable-discount-codes-latency";

function agent() {
  return request.agent(createApp());
}

function setVariation(value: string) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key === FLAG ? value : fallback,
  );
}

// Scoped to this flag's events: other flags (e.g. enable-inventory-tracking)
// emit their own telemetry from the same checkout handler.
function eventKeys(): string[] {
  return mocks.trackEvent.mock.calls
    .map((c) => c[0] as string)
    .filter((k) => k.startsWith("enable-discount-codes-"));
}

function checkoutEvents(): unknown[][] {
  return mocks.trackEvent.mock.calls.filter((c) => String(c[0]).startsWith("enable-discount-codes-"));
}

beforeEach(() => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  mocks.placeOrderShouldThrow = false;
});

describe.each(["control", "v1"])("enable-discount-codes telemetry (%s)", (variation) => {
  beforeEach(() => setVariation(variation));

  it("successful checkout: order-placed + latency on the flag's session, no error", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    await session.post("/api/checkout").expect(201);

    const events = checkoutEvents();
    expect(events.map((c) => c[0])).toEqual([ORDER_PLACED, LATENCY]);
    const flagSession = mocks.getVariation.mock.calls.find((c) => c[0] === FLAG)?.[1];
    expect(flagSession).toEqual(expect.any(String));
    for (const call of events) expect(call[1]).toBe(flagSession);
    const latency = events.find((c) => c[0] === LATENCY)!;
    expect(typeof latency[2]).toBe("number");
    expect(latency[2] as number).toBeGreaterThanOrEqual(0);
  });

  it("empty cart 400: latency only, no order-placed or error", async () => {
    await agent().post("/api/checkout").expect(400);
    expect(eventKeys()).toEqual([LATENCY]);
  });

  it("unexpected failure: error + latency, no order-placed, request fails with 500", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    mocks.placeOrderShouldThrow = true;
    await session.post("/api/checkout").expect(500);

    expect(checkoutEvents().map((c) => c[0])).toEqual([ERROR, LATENCY]);
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines).toHaveLength(1);
  });
});

describe("enable-discount-codes telemetry: unknown code", () => {
  it("control: code ignored, order placed and counted", async () => {
    setVariation("control");
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    await session.post("/api/checkout").send({ discountCode: "NOTACODE" }).expect(201);
    expect(eventKeys()).toEqual([ORDER_PLACED, LATENCY]);
  });

  it("v1: 400 is not an order and not an error, but latency is recorded", async () => {
    setVariation("v1");
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    mocks.trackEvent.mockClear();
    await session.post("/api/checkout").send({ discountCode: "NOTACODE" }).expect(400);
    expect(eventKeys()).toEqual([LATENCY]);
  });
});
