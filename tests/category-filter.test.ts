import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Flag-path tests for `enable-category-filter` (string multivariate: "control" | "v1").
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
import { products as catalog } from "../src/catalog.js";

const FLAG = "enable-category-filter";

// The public product shape: with enable-inventory-tracking on control (the
// default here), the API omits the catalog's `stock` field.
const products = catalog.map(({ stock: _stock, ...p }) => p);

function agent() {
  return request.agent(createApp());
}

function setVariation(value: string) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key === FLAG ? value : fallback,
  );
}

function eventCalls(eventKey: string) {
  return mocks.trackEvent.mock.calls.filter(([key]) => key === eventKey);
}

beforeEach(() => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
});

describe("enable-category-filter: GET /api/products", () => {
  describe("control (flag off)", () => {
    beforeEach(() => setVariation("control"));

    it("returns the full catalog with no category param", async () => {
      const res = await agent().get("/api/products").expect(200);
      expect(res.body.products).toEqual(products);
      expect(mocks.getVariation).toHaveBeenCalledWith(FLAG, expect.any(String), "control");
    });

    it("ignores a valid category param and returns the full catalog", async () => {
      const res = await agent().get("/api/products?category=gear").expect(200);
      expect(res.body.products).toEqual(products);
    });

    it("ignores an unknown category instead of returning 400", async () => {
      const res = await agent().get("/api/products?category=snacks").expect(200);
      expect(res.body.products).toEqual(products);
    });
  });

  describe("v1 (flag on)", () => {
    beforeEach(() => setVariation("v1"));

    it("returns the full catalog with no category param", async () => {
      const res = await agent().get("/api/products").expect(200);
      expect(res.body.products).toEqual(products);
    });

    it("filters to beans", async () => {
      const res = await agent().get("/api/products?category=beans").expect(200);
      expect(res.body.products.length).toBeGreaterThan(0);
      expect(res.body.products).toEqual(products.filter((p) => p.category === "beans"));
    });

    it("filters to gear", async () => {
      const res = await agent().get("/api/products?category=gear").expect(200);
      expect(res.body.products.length).toBeGreaterThan(0);
      expect(res.body.products).toEqual(products.filter((p) => p.category === "gear"));
    });

    it("rejects an unknown category with 400", async () => {
      const res = await agent().get("/api/products?category=snacks").expect(400);
      expect(res.body.error).toBe("unknown category");
    });
  });

  describe("unexpected variation values fall back to control behavior", () => {
    it("treats an unknown variation like control", async () => {
      setVariation("v2");
      const res = await agent().get("/api/products?category=snacks").expect(200);
      expect(res.body.products).toEqual(products);
    });
  });
});

describe("enable-category-filter: GET /api/storefront", () => {
  it("control: categoryFilter is false", async () => {
    setVariation("control");
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.categoryFilter).toBe(false);
    expect(res.body.name).toBe("Shopfront");
  });

  it("v1: categoryFilter is true", async () => {
    setVariation("v1");
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.categoryFilter).toBe(true);
    expect(res.body.name).toBe("Shopfront");
  });
});

describe("enable-category-filter: guarded-release telemetry on /api/products", () => {
  for (const variation of ["control", "v1"]) {
    it(`${variation}: a successful request emits products-loaded once and latency once`, async () => {
      setVariation(variation);
      const path = variation === "v1" ? "/api/products?category=beans" : "/api/products";
      await agent().get(path).expect(200);

      expect(eventCalls("enable-category-filter-products-loaded")).toHaveLength(1);
      const latency = eventCalls("enable-category-filter-latency");
      expect(latency).toHaveLength(1);
      expect(typeof latency[0][2]).toBe("number");
      expect(latency[0][2]).toBeGreaterThanOrEqual(0);
      expect(eventCalls("enable-category-filter-error")).toHaveLength(0);
    });
  }

  it("events are emitted for the same session key the flag is evaluated on", async () => {
    setVariation("control");
    await agent().get("/api/products").expect(200);
    const sessionId = mocks.getVariation.mock.calls[0][1];
    for (const [, sid] of mocks.trackEvent.mock.calls) {
      expect(sid).toBe(sessionId);
    }
  });

  it("v1: an unknown-category 400 emits latency but not products-loaded or error", async () => {
    setVariation("v1");
    await agent().get("/api/products?category=snacks").expect(400);
    expect(eventCalls("enable-category-filter-latency")).toHaveLength(1);
    expect(eventCalls("enable-category-filter-products-loaded")).toHaveLength(0);
    expect(eventCalls("enable-category-filter-error")).toHaveLength(0);
  });

  it("a handler failure emits error and latency, and still surfaces as a 500", async () => {
    mocks.getVariation.mockRejectedValue(new Error("boom"));
    await agent().get("/api/products").expect(500);
    expect(eventCalls("enable-category-filter-error")).toHaveLength(1);
    expect(eventCalls("enable-category-filter-latency")).toHaveLength(1);
    expect(eventCalls("enable-category-filter-products-loaded")).toHaveLength(0);
  });
});

describe("flags module without LaunchDarkly configured", () => {
  it("trackEvent is a no-op that does not throw", async () => {
    const actual = await vi.importActual<typeof import("../src/flags.js")>("../src/flags.js");
    const prev = process.env.LD_SDK_KEY;
    delete process.env.LD_SDK_KEY;
    try {
      expect(() => actual.trackEvent("enable-category-filter-latency", "s1", 12)).not.toThrow();
      expect(await actual.getVariation(FLAG, "s1", "control")).toBe("control");
    } finally {
      if (prev !== undefined) process.env.LD_SDK_KEY = prev;
    }
  });
});
