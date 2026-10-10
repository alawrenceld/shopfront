import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Additional flag-path tests for `enable-cart-quantity-editing`
// (string multivariate: "control" | "v1"). Covers v1 edge cases, checkout after
// an edit, error/latency telemetry on both arms, and the session context used.
const mocks = vi.hoisted(() => ({
  getVariation: vi.fn(),
  isEnabled: vi.fn(),
  trackEvent: vi.fn(),
  cartFailure: undefined as undefined | "setQuantity" | "viewCart",
}));

vi.mock("../src/flags.js", () => ({
  getVariation: mocks.getVariation,
  isEnabled: mocks.isEnabled,
  trackEvent: mocks.trackEvent,
  contextForSession: (sessionId: string) => ({ kind: "user", key: sessionId }),
  closeFlags: async () => {},
}));

// Real cart implementation, with an opt-in failure injection for the error path.
vi.mock("../src/cart.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cart.js")>();
  return {
    ...actual,
    setQuantity: (...args: Parameters<typeof actual.setQuantity>) => {
      if (mocks.cartFailure === "setQuantity") throw new Error("boom: setQuantity");
      return actual.setQuantity(...args);
    },
    viewCart: (...args: Parameters<typeof actual.viewCart>) => {
      if (mocks.cartFailure === "viewCart") throw new Error("boom: viewCart");
      return actual.viewCart(...args);
    },
  };
});

import { createApp } from "../src/server.js";

const FLAG = "enable-cart-quantity-editing";
const ERROR_EVENT = "enable-cart-quantity-editing-error";
const LATENCY_EVENT = "enable-cart-quantity-editing-latency";
const UPDATED_EVENT = "enable-cart-quantity-editing-quantity-updated";

function agent() {
  return request.agent(createApp());
}

function setVariation(value: string) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key === FLAG ? value : fallback,
  );
}

function eventKeys() {
  return mocks.trackEvent.mock.calls.map((c) => c[0]);
}

function callsFor(eventKey: string) {
  return mocks.trackEvent.mock.calls.filter((c) => c[0] === eventKey);
}

function sessionIdOf(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const match = cookies.map((c) => /shopfront_session=([^;]+)/.exec(c)).find(Boolean);
  if (!match) throw new Error("no session cookie");
  return decodeURIComponent(match[1]);
}

beforeEach(() => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  mocks.cartFailure = undefined;
});

describe("enable-cart-quantity-editing: v1 (flag on) edge cases", () => {
  beforeEach(() => setVariation("v1"));

  it("adds a new line when the product is not yet in the cart", async () => {
    const session = agent();
    const res = await session.patch("/api/cart/beans-colombia").send({ quantity: 2 }).expect(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({ productId: "beans-colombia", quantity: 2 });
    expect(res.body.totalCents).toBe(2 * 1650);
  });

  it("accepts the 0 and 99 boundaries", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-filters" }).expect(200);
    const max = await session.patch("/api/cart/gear-filters").send({ quantity: 99 }).expect(200);
    expect(max.body.lines[0].quantity).toBe(99);
    const zero = await session.patch("/api/cart/gear-filters").send({ quantity: 0 }).expect(200);
    expect(zero.body.lines).toEqual([]);
  });

  it("rejects missing, string, and negative quantities without touching the cart", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-v60", quantity: 2 }).expect(200);
    await session.patch("/api/cart/gear-v60").send({}).expect(400);
    await session.patch("/api/cart/gear-v60").send({ quantity: "5" }).expect(400);
    await session.patch("/api/cart/gear-v60").send({ quantity: -1 }).expect(400);
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines[0].quantity).toBe(2);
    expect(eventKeys()).not.toContain(UPDATED_EVENT);
    expect(eventKeys()).not.toContain(ERROR_EVENT);
  });

  it("checkout totals reflect the edited quantity", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
    await session.post("/api/cart").send({ productId: "beans-ethiopia" }).expect(200);
    await session.patch("/api/cart/gear-v60").send({ quantity: 3 }).expect(200);
    const res = await session.post("/api/checkout").send({}).expect(201);
    expect(res.body.order.subtotalCents).toBe(3 * 2800 + 1850);
    expect(res.body.order.totalCents).toBe(3 * 2800 + 1850);
  });
});

describe("enable-cart-quantity-editing: control (flag off) is pre-PR behavior", () => {
  beforeEach(() => setVariation("control"));

  it("does not add a line for a product not in the cart", async () => {
    const session = agent();
    await session.patch("/api/cart/beans-colombia").send({ quantity: 2 }).expect(404);
    const cart = await session.get("/api/cart").expect(200);
    expect(cart.body.lines).toEqual([]);
  });

  it("checkout totals use the original quantity", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
    await session.patch("/api/cart/gear-v60").send({ quantity: 3 }).expect(404);
    const res = await session.post("/api/checkout").send({}).expect(201);
    expect(res.body.order.totalCents).toBe(2800);
  });

  it("never reaches the cart, so injected cart failures do not surface", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
    mocks.cartFailure = "setQuantity";
    await session.patch("/api/cart/gear-v60").send({ quantity: 3 }).expect(404);
    expect(eventKeys()).not.toContain(ERROR_EVENT);
  });
});

describe("enable-cart-quantity-editing: guarded-release telemetry", () => {
  for (const failure of ["setQuantity", "viewCart"] as const) {
    it(`v1: emits the error event and returns 500 when ${failure} throws`, async () => {
      setVariation("v1");
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
      mocks.trackEvent.mockReset();
      mocks.cartFailure = failure;
      await session.patch("/api/cart/gear-v60").send({ quantity: 3 }).expect(500);
      expect(callsFor(ERROR_EVENT)).toHaveLength(1);
      expect(callsFor(LATENCY_EVENT)).toHaveLength(1);
      expect(eventKeys()).not.toContain(UPDATED_EVENT);
    });
  }

  it("emits the error event when the flag lookup rejects (re-thrown as 500)", async () => {
    mocks.getVariation.mockRejectedValue(new Error("lookup failed"));
    await agent().patch("/api/cart/gear-v60").send({ quantity: 3 }).expect(500);
    expect(callsFor(ERROR_EVENT)).toHaveLength(1);
    expect(callsFor(LATENCY_EVENT)).toHaveLength(1);
  });

  for (const variation of ["control", "v1"]) {
    it(`${variation}: latency carries a numeric value and all events use the request's session id`, async () => {
      setVariation(variation);
      const session = agent();
      const first = await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
      const sessionId = sessionIdOf(first);
      mocks.trackEvent.mockReset();
      mocks.getVariation.mockClear();

      await session.patch("/api/cart/gear-v60").send({ quantity: 4 });

      expect(mocks.getVariation).toHaveBeenCalledWith(FLAG, sessionId, "control");
      const latency = callsFor(LATENCY_EVENT);
      expect(latency).toHaveLength(1);
      expect(typeof latency[0][2]).toBe("number");
      expect(latency[0][2]).toBeGreaterThanOrEqual(0);
      for (const call of mocks.trackEvent.mock.calls) {
        expect(call[1]).toBe(sessionId);
      }
      if (variation === "v1") {
        expect(callsFor(UPDATED_EVENT)).toHaveLength(1);
      } else {
        expect(callsFor(UPDATED_EVENT)).toHaveLength(0);
      }
    });
  }
});
