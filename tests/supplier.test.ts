import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import {
  verifyStockWithSupplier,
  SupplierTimeoutError,
  supplierConfig,
  DEFAULT_VERIFY_DELAY_MS,
  DEFAULT_VERIFY_TIMEOUT_MS,
} from "../src/supplier.js";

// Checkout's supplier verification is gated by `enable-supplier-stock-verification`
// (string multivariate: "control" | "v1"). Flags are mocked so each test pins the arm.
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

const FLAG = "enable-supplier-stock-verification";

function setVariations(variations: Record<string, string>) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key in variations ? variations[key] : fallback,
  );
}

function agent() {
  return request.agent(createApp());
}

const savedEnv = {
  delay: process.env.SUPPLIER_VERIFY_DELAY_MS,
  timeout: process.env.SUPPLIER_VERIFY_TIMEOUT_MS,
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  setVariations({ [FLAG]: "v1" });
});

afterEach(() => {
  restoreEnv("SUPPLIER_VERIFY_DELAY_MS", savedEnv.delay);
  restoreEnv("SUPPLIER_VERIFY_TIMEOUT_MS", savedEnv.timeout);
});

describe("supplier config parsing", () => {
  it("uses the defaults when unset", () => {
    delete process.env.SUPPLIER_VERIFY_DELAY_MS;
    delete process.env.SUPPLIER_VERIFY_TIMEOUT_MS;
    expect(supplierConfig()).toEqual({
      delayMs: DEFAULT_VERIFY_DELAY_MS,
      timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    });
  });

  it.each(["", "   ", "abc", "NaN", "-5", "Infinity"])("falls back to the defaults for %j", (raw) => {
    process.env.SUPPLIER_VERIFY_DELAY_MS = raw;
    process.env.SUPPLIER_VERIFY_TIMEOUT_MS = raw;
    expect(supplierConfig()).toEqual({
      delayMs: DEFAULT_VERIFY_DELAY_MS,
      timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    });
  });

  it("accepts finite numbers >= 0, including 0", () => {
    process.env.SUPPLIER_VERIFY_DELAY_MS = "0";
    process.env.SUPPLIER_VERIFY_TIMEOUT_MS = "250";
    expect(supplierConfig()).toEqual({ delayMs: 0, timeoutMs: 250 });
  });

  it("default timeout is below the feed's slowest response, so the retry path is reachable", () => {
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBeLessThan(DEFAULT_VERIFY_DELAY_MS * 1.5);
  });

  it("a non-numeric timeout no longer disables the timeout check", async () => {
    // delay 1000 * (0.5 + 0.9) = 1400ms > default 500ms timeout -> fails closed.
    process.env.SUPPLIER_VERIFY_DELAY_MS = "1000";
    process.env.SUPPLIER_VERIFY_TIMEOUT_MS = "abc";
    // Real timers: two attempts each capped at the 500ms default (~1s total).
    const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
    try {
      await expect(
        verifyStockWithSupplier([{ productId: "gear-v60", quantity: 1 }]),
      ).rejects.toBeInstanceOf(SupplierTimeoutError);
      expect(random).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });
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

  it("v1: checkout still succeeds when verification passes", async () => {
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-filters" }).expect(200);
    await session.post("/api/checkout").expect(201);
  });

  it("v1: checkout fails closed with a 503 and keeps the cart when verification times out", async () => {
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

  it("control: checkout never consults the supplier (succeeds even when it would time out)", async () => {
    setVariations({ [FLAG]: "control" });
    const session = agent();
    await session.post("/api/cart").send({ productId: "gear-filters" }).expect(200);

    process.env.SUPPLIER_VERIFY_DELAY_MS = "10";
    process.env.SUPPLIER_VERIFY_TIMEOUT_MS = "0";
    await session.post("/api/checkout").expect(201);
  });
});
