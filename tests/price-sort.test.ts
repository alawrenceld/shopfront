import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Flag-path tests for `enable-price-sort` (string multivariate: "control" | "v1").
// The flags module is mocked so each test can force the variation the server sees
// for each flag independently.
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
import { products } from "../src/catalog.js";

const FLAG = "enable-price-sort";
const CATEGORY_FLAG = "enable-category-filter";

type Product = (typeof products)[number];

function agent() {
  return request.agent(createApp());
}

function setVariations(variations: Record<string, string>) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key in variations ? variations[key] : fallback,
  );
}

function setVariation(value: string) {
  setVariations({ [FLAG]: value });
}

function eventCalls(eventKey: string) {
  return mocks.trackEvent.mock.calls.filter(([key]) => key === eventKey);
}

function prices(list: Product[]) {
  return list.map((p) => p.priceCents);
}

const ascending = () => [...products].sort((a, b) => a.priceCents - b.priceCents);
const descending = () => [...products].sort((a, b) => b.priceCents - a.priceCents);

beforeEach(() => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
});

it("sanity: the catalog is not already in price order (so sort tests are meaningful)", () => {
  expect(prices(products)).not.toEqual(prices(ascending()));
  expect(prices(products)).not.toEqual(prices(descending()));
});

describe("enable-price-sort: GET /api/products", () => {
  describe("control (flag off)", () => {
    beforeEach(() => setVariation("control"));

    it("returns the catalog in its original order with no sort param", async () => {
      const res = await agent().get("/api/products").expect(200);
      expect(res.body.products).toEqual(products);
      expect(mocks.getVariation).toHaveBeenCalledWith(FLAG, expect.any(String), "control");
    });

    it("ignores sort=price-asc", async () => {
      const res = await agent().get("/api/products?sort=price-asc").expect(200);
      expect(res.body.products).toEqual(products);
    });

    it("ignores sort=price-desc", async () => {
      const res = await agent().get("/api/products?sort=price-desc").expect(200);
      expect(res.body.products).toEqual(products);
    });

    it("does not reject an unknown sort value", async () => {
      const res = await agent().get("/api/products?sort=alphabetical").expect(200);
      expect(res.body.products).toEqual(products);
    });

    it("does not reject a repeated sort param", async () => {
      const res = await agent().get("/api/products?sort=price-asc&sort=price-desc").expect(200);
      expect(res.body.products).toEqual(products);
    });
  });

  describe("v1 (flag on)", () => {
    beforeEach(() => setVariation("v1"));

    it("returns the catalog in its original order with no sort param", async () => {
      const res = await agent().get("/api/products").expect(200);
      expect(res.body.products).toEqual(products);
    });

    it("sorts ascending by price with sort=price-asc", async () => {
      const res = await agent().get("/api/products?sort=price-asc").expect(200);
      expect(res.body.products).toEqual(ascending());
    });

    it("sorts descending by price with sort=price-desc", async () => {
      const res = await agent().get("/api/products?sort=price-desc").expect(200);
      expect(res.body.products).toEqual(descending());
    });

    it("rejects an unknown sort value with 400", async () => {
      const res = await agent().get("/api/products?sort=alphabetical").expect(400);
      expect(res.body.error).toBe("unknown sort");
    });

    it("rejects a repeated sort param with 400", async () => {
      const res = await agent().get("/api/products?sort=price-asc&sort=price-desc").expect(400);
      expect(res.body.error).toBe("unknown sort");
    });

    it("does not mutate the shared catalog when sorting", async () => {
      const before = products.map((p) => p.id);
      await agent().get("/api/products?sort=price-desc").expect(200);
      await agent().get("/api/products?sort=price-asc").expect(200);
      expect(products.map((p) => p.id)).toEqual(before);
      const res = await agent().get("/api/products").expect(200);
      expect(res.body.products).toEqual(products);
    });
  });

  describe("combined with enable-category-filter", () => {
    it("price-sort v1 + category v1: filters then sorts", async () => {
      setVariations({ [FLAG]: "v1", [CATEGORY_FLAG]: "v1" });
      const asc = await agent().get("/api/products?category=gear&sort=price-asc").expect(200);
      const gear = products.filter((p) => p.category === "gear");
      expect(asc.body.products.length).toBeGreaterThan(0);
      expect(asc.body.products).toEqual([...gear].sort((a, b) => a.priceCents - b.priceCents));

      const desc = await agent().get("/api/products?category=beans&sort=price-desc").expect(200);
      const beans = products.filter((p) => p.category === "beans");
      expect(desc.body.products).toEqual([...beans].sort((a, b) => b.priceCents - a.priceCents));
    });

    it("price-sort v1 + category v1: unknown category still 400s", async () => {
      setVariations({ [FLAG]: "v1", [CATEGORY_FLAG]: "v1" });
      const res = await agent().get("/api/products?category=snacks&sort=price-asc").expect(400);
      expect(res.body.error).toBe("unknown category");
    });

    it("price-sort v1 + category control: category is ignored, sort applies to full catalog", async () => {
      setVariations({ [FLAG]: "v1", [CATEGORY_FLAG]: "control" });
      const res = await agent().get("/api/products?category=gear&sort=price-asc").expect(200);
      expect(res.body.products).toEqual(ascending());
    });

    it("price-sort control + category v1: filters but keeps catalog order", async () => {
      setVariations({ [FLAG]: "control", [CATEGORY_FLAG]: "v1" });
      const res = await agent().get("/api/products?category=gear&sort=price-asc").expect(200);
      expect(res.body.products).toEqual(products.filter((p) => p.category === "gear"));
    });
  });

  describe("unexpected variation values fall back to control behavior", () => {
    it("treats an unknown variation like control", async () => {
      setVariation("v2");
      const res = await agent().get("/api/products?sort=alphabetical").expect(200);
      expect(res.body.products).toEqual(products);
      const sorted = await agent().get("/api/products?sort=price-asc").expect(200);
      expect(sorted.body.products).toEqual(products);
    });
  });
});

describe("enable-price-sort: GET /api/storefront", () => {
  it("control: priceSort is false", async () => {
    setVariation("control");
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.priceSort).toBe(false);
    expect(res.body.name).toBe("Shopfront");
  });

  it("v1: priceSort is true", async () => {
    setVariation("v1");
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.priceSort).toBe(true);
    expect(res.body.name).toBe("Shopfront");
  });
});

describe("enable-price-sort: guarded-release telemetry on /api/products", () => {
  for (const variation of ["control", "v1"]) {
    it(`${variation}: a successful request emits products-loaded once and latency once`, async () => {
      setVariation(variation);
      await agent().get("/api/products?sort=price-asc").expect(200);

      expect(eventCalls("enable-price-sort-products-loaded")).toHaveLength(1);
      const latency = eventCalls("enable-price-sort-latency");
      expect(latency).toHaveLength(1);
      expect(typeof latency[0][2]).toBe("number");
      expect(latency[0][2]).toBeGreaterThanOrEqual(0);
      expect(eventCalls("enable-price-sort-error")).toHaveLength(0);
    });
  }

  it("events are emitted for the same session key the flag is evaluated on", async () => {
    setVariation("v1");
    await agent().get("/api/products?sort=price-desc").expect(200);
    const call = mocks.getVariation.mock.calls.find(([key]) => key === FLAG);
    expect(call).toBeDefined();
    const sessionId = call![1];
    const priceSortEvents = mocks.trackEvent.mock.calls.filter(([key]) =>
      String(key).startsWith("enable-price-sort-"),
    );
    expect(priceSortEvents.length).toBeGreaterThan(0);
    for (const [, sid] of priceSortEvents) {
      expect(sid).toBe(sessionId);
    }
  });

  it("v1: an unknown-sort 400 emits latency but not products-loaded or error", async () => {
    setVariation("v1");
    await agent().get("/api/products?sort=alphabetical").expect(400);
    expect(eventCalls("enable-price-sort-latency")).toHaveLength(1);
    expect(eventCalls("enable-price-sort-products-loaded")).toHaveLength(0);
    expect(eventCalls("enable-price-sort-error")).toHaveLength(0);
  });

  it("a handler failure emits error and latency, and still surfaces as a 500", async () => {
    mocks.getVariation.mockRejectedValue(new Error("boom"));
    await agent().get("/api/products").expect(500);
    expect(eventCalls("enable-price-sort-error")).toHaveLength(1);
    expect(eventCalls("enable-price-sort-latency")).toHaveLength(1);
    expect(eventCalls("enable-price-sort-products-loaded")).toHaveLength(0);
  });
});
