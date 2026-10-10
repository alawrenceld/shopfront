import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Flag-path tests for `enable-cart-quantity-editing` (string multivariate: "control" | "v1").
// The flags module is mocked so each test can force the variation the server sees.
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

const FLAG = "enable-cart-quantity-editing";

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

describe("enable-cart-quantity-editing: PATCH /api/cart/:productId", () => {
  describe("control (flag off)", () => {
    beforeEach(() => setVariation("control"));

    it("returns 404 before validation and leaves the cart untouched", async () => {
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
      await session.patch("/api/cart/gear-v60").send({ quantity: 5 }).expect(404);
      await session.patch("/api/cart/gear-v60").send({ quantity: -1 }).expect(404);
      await session.patch("/api/cart/nope").send({ quantity: 2 }).expect(404);
      const cart = await session.get("/api/cart").expect(200);
      expect(cart.body.lines[0].quantity).toBe(1);
      expect(mocks.getVariation).toHaveBeenCalledWith(FLAG, expect.any(String), "control");
    });

    it("an unexpected variation behaves like control", async () => {
      setVariation("v2");
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
      await session.patch("/api/cart/gear-v60").send({ quantity: 5 }).expect(404);
    });
  });

  describe("v1 (flag on)", () => {
    beforeEach(() => setVariation("v1"));

    it("sets a line's quantity directly", async () => {
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
      const res = await session.patch("/api/cart/gear-v60").send({ quantity: 5 }).expect(200);
      expect(res.body.lines[0].quantity).toBe(5);
      expect(res.body.totalCents).toBe(5 * 2800);
    });

    it("removes a line when quantity is set to zero", async () => {
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
      const res = await session.patch("/api/cart/gear-v60").send({ quantity: 0 }).expect(200);
      expect(res.body.lines).toEqual([]);
    });

    it("rejects invalid quantity updates", async () => {
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
      await session.patch("/api/cart/gear-v60").send({ quantity: 100 }).expect(400);
      await session.patch("/api/cart/gear-v60").send({ quantity: 1.5 }).expect(400);
      await session.patch("/api/cart/nope").send({ quantity: 2 }).expect(400);
    });
  });

  it("emits error-free guarded-release telemetry on both control and v1", async () => {
    for (const variation of ["control", "v1"]) {
      mocks.trackEvent.mockReset();
      setVariation(variation);
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-v60" }).expect(200);
      await session.patch("/api/cart/gear-v60").send({ quantity: 3 });
      const keys = mocks.trackEvent.mock.calls.map((c) => c[0]);
      expect(keys).toContain("enable-cart-quantity-editing-latency");
      expect(keys).not.toContain("enable-cart-quantity-editing-error");
      if (variation === "v1") {
        expect(keys).toContain("enable-cart-quantity-editing-quantity-updated");
      } else {
        expect(keys).not.toContain("enable-cart-quantity-editing-quantity-updated");
      }
    }
  });
});

describe("enable-cart-quantity-editing: GET /api/storefront", () => {
  it("control: cartQuantityEditing is false", async () => {
    setVariation("control");
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.cartQuantityEditing).toBe(false);
  });

  it("v1: cartQuantityEditing is true", async () => {
    setVariation("v1");
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.cartQuantityEditing).toBe(true);
  });
});
