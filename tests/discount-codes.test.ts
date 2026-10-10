import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Flag-path tests for `enable-discount-codes` (string multivariate: "control" | "v1").
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

const FLAG = "enable-discount-codes";

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

describe("enable-discount-codes: POST /api/checkout", () => {
  describe("control (flag off)", () => {
    beforeEach(() => setVariation("control"));

    it("ignores a valid code and charges full price", async () => {
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
      const res = await session.post("/api/checkout").send({ discountCode: "SAVE10" }).expect(201);
      expect(res.body.order.totalCents).toBe(5400);
      expect(res.body.order.discountCents).toBe(0);
      expect(res.body.order.discountCode).toBeUndefined();
      expect(mocks.getVariation).toHaveBeenCalledWith(FLAG, expect.any(String), "control");
    });

    it("does not reject unknown or non-string codes", async () => {
      for (const discountCode of ["NOTACODE", 42, { code: "SAVE10" }]) {
        const session = agent();
        await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
        const res = await session.post("/api/checkout").send({ discountCode }).expect(201);
        expect(res.body.order.totalCents).toBe(5400);
        const cart = await session.get("/api/cart").expect(200);
        expect(cart.body.lines).toEqual([]);
      }
    });
  });

  describe("v1 (flag on)", () => {
    beforeEach(() => setVariation("v1"));

    it("applies SAVE10 to the subtotal", async () => {
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
      const res = await session.post("/api/checkout").send({ discountCode: "SAVE10" }).expect(201);
      expect(res.body.order.subtotalCents).toBe(5400);
      expect(res.body.order.discountCents).toBe(540);
      expect(res.body.order.totalCents).toBe(4860);
      expect(res.body.order.discountCode).toBe("SAVE10");
      const order = await session.get(`/api/orders/${res.body.order.id}`).expect(200);
      expect(order.body.order.discountCents).toBe(540);
    });

    it("accepts codes case-insensitively and trims whitespace", async () => {
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-filters" }).expect(200);
      const res = await session.post("/api/checkout").send({ discountCode: "  save10 " }).expect(201);
      expect(res.body.order.discountCode).toBe("SAVE10");
      expect(res.body.order.discountCents).toBe(95);
    });

    it("rejects an unknown code with 400 and keeps the cart", async () => {
      const session = agent();
      await session.post("/api/cart").send({ productId: "beans-colombia" }).expect(200);
      const res = await session.post("/api/checkout").send({ discountCode: "NOTACODE" }).expect(400);
      expect(res.body.error).toBe("invalid discount code");
      const cart = await session.get("/api/cart").expect(200);
      expect(cart.body.lines).toHaveLength(1);
    });

    it("rejects a non-string code with 400", async () => {
      const session = agent();
      await session.post("/api/cart").send({ productId: "beans-colombia" }).expect(200);
      await session.post("/api/checkout").send({ discountCode: 10 }).expect(400);
    });

    it("places an undiscounted order with no or empty code", async () => {
      for (const body of [{}, { discountCode: "" }]) {
        const session = agent();
        await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
        const res = await session.post("/api/checkout").send(body).expect(201);
        expect(res.body.order.discountCents).toBe(0);
        expect(res.body.order.totalCents).toBe(5400);
      }
    });
  });

  it("emits guarded-release events on both control and v1", async () => {
    for (const variation of ["control", "v1"]) {
      mocks.trackEvent.mockReset();
      setVariation(variation);
      const session = agent();
      await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
      await session.post("/api/checkout").send({ discountCode: "SAVE10" }).expect(201);
      const keys = mocks.trackEvent.mock.calls.map((c) => c[0]);
      expect(keys).toContain("enable-discount-codes-order-placed");
      expect(keys).toContain("enable-discount-codes-latency");
      expect(keys).not.toContain("enable-discount-codes-error");
    }
  });

  it("an unexpected variation behaves like control", async () => {
    setVariation("v2");
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-kettle" }).expect(200);
    const res = await session.post("/api/checkout").send({ discountCode: "NOTACODE" }).expect(201);
    expect(res.body.order.totalCents).toBe(5400);
  });
});

describe("enable-discount-codes: GET /api/storefront", () => {
  it("control: discountCodes is false", async () => {
    setVariation("control");
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.discountCodes).toBe(false);
  });

  it("v1: discountCodes is true", async () => {
    setVariation("v1");
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.discountCodes).toBe(true);
  });
});
