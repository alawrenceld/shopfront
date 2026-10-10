import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type express from "express";

// Flag-path tests for `enable-product-search` (string multivariate:
// "control" | "v1"). Each wrapped path is exercised as a paired control / v1
// case: the ?q= handling in GET /api/products, the productSearch field on
// GET /api/storefront, and the guarded-release telemetry (products-loaded /
// error / latency) emitted on both arms. Complements product-search.test.ts.
const mocks = vi.hoisted(() => ({
  getVariation: vi.fn(),
  isEnabled: vi.fn(),
  trackEvent: vi.fn(),
  searchShouldThrow: false,
}));

vi.mock("../src/flags.js", () => ({
  getVariation: mocks.getVariation,
  isEnabled: mocks.isEnabled,
  trackEvent: mocks.trackEvent,
  contextForSession: (sessionId: string) => ({ kind: "user", key: sessionId }),
  closeFlags: async () => {},
}));

// Pass-through catalog with a switch to force searchByName to fail (v1-only code).
vi.mock("../src/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/catalog.js")>();
  return {
    ...actual,
    searchByName: (...args: Parameters<typeof actual.searchByName>) => {
      if (mocks.searchShouldThrow) throw new Error("search exploded");
      return actual.searchByName(...args);
    },
  };
});

const FLAG = "enable-product-search";
const CATEGORY_FLAG = "enable-category-filter";
const PRICE_SORT_FLAG = "enable-price-sort";
const LOADED = "enable-product-search-products-loaded";
const ERROR = "enable-product-search-error";
const LATENCY = "enable-product-search-latency";

let app: express.Express;
let catalog: { id: string; name: string; category: string; priceCents: number; stock: number }[];
let publicProducts: Omit<(typeof catalog)[number], "stock">[];

function agent() {
  return request.agent(app);
}

function setVariations(variations: Record<string, string>) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key in variations ? variations[key] : fallback,
  );
}

// Scoped to this flag's events: other flags emit telemetry from the same handler.
function searchEvents(): unknown[][] {
  return mocks.trackEvent.mock.calls.filter((c) => String(c[0]).startsWith("enable-product-search-"));
}

function eventKeys(): string[] {
  return searchEvents().map((c) => c[0] as string);
}

function names(list: { name: string }[]) {
  return list.map((p) => p.name);
}

beforeEach(async () => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  mocks.searchShouldThrow = false;
  vi.resetModules();
  const { createApp } = await import("../src/server.js");
  const cat = await import("../src/catalog.js");
  catalog = cat.products;
  publicProducts = catalog.map(({ stock: _stock, ...p }) => p);
  app = createApp();
});

describe("GET /api/products?q= — paired control / v1", () => {
  it("v1: ?q=kettle narrows to matching names", async () => {
    setVariations({ [FLAG]: "v1" });
    const res = await agent().get("/api/products?q=kettle").expect(200);
    expect(names(res.body.products)).toEqual(["Gooseneck Kettle"]);
  });

  it("control: ?q=kettle is ignored and the full catalog is returned", async () => {
    setVariations({ [FLAG]: "control" });
    const res = await agent().get("/api/products?q=kettle").expect(200);
    expect(res.body.products).toEqual(publicProducts);
  });

  it("v1: a no-match query returns an empty list", async () => {
    setVariations({ [FLAG]: "v1" });
    const res = await agent().get("/api/products?q=zzz-no-such-product").expect(200);
    expect(res.body.products).toEqual([]);
  });

  it("control: the same no-match query still returns the full catalog", async () => {
    setVariations({ [FLAG]: "control" });
    const res = await agent().get("/api/products?q=zzz-no-such-product").expect(200);
    expect(res.body.products).toEqual(publicProducts);
  });

  it("v1: a repeated q param is rejected with 400", async () => {
    setVariations({ [FLAG]: "v1" });
    const res = await agent().get("/api/products?q=a&q=b").expect(400);
    expect(res.body).toEqual({ error: "invalid search query" });
  });

  it("control: a repeated q param is not validated (200, full catalog)", async () => {
    setVariations({ [FLAG]: "control" });
    const res = await agent().get("/api/products?q=a&q=b").expect(200);
    expect(res.body.products).toEqual(publicProducts);
  });

  it("flag unavailable (fallback) behaves exactly like control", async () => {
    // No variation for the search flag -> getVariation returns the "control" fallback.
    setVariations({});
    const res = await agent().get("/api/products?q=kettle&q=dripper").expect(200);
    expect(res.body.products).toEqual(publicProducts);
  });

  it("an unexpected variation value is treated as control", async () => {
    setVariations({ [FLAG]: "v2" });
    const res = await agent().get("/api/products?q=kettle").expect(200);
    expect(res.body.products).toEqual(publicProducts);
  });

  it("v1 and control return identical results when no q is sent", async () => {
    setVariations({ [FLAG]: "v1" });
    const v1 = await agent().get("/api/products").expect(200);
    setVariations({ [FLAG]: "control" });
    const control = await agent().get("/api/products").expect(200);
    expect(v1.body.products).toEqual(control.body.products);
    expect(control.body.products).toEqual(publicProducts);
  });
});

describe("GET /api/products?q= alongside other flags — paired control / v1", () => {
  it("v1: search applies within the category filter", async () => {
    setVariations({ [FLAG]: "v1", [CATEGORY_FLAG]: "v1" });
    const res = await agent().get("/api/products?category=gear&q=kettle").expect(200);
    expect(names(res.body.products)).toEqual(["Gooseneck Kettle"]);
  });

  it("control: category filter still applies but q is ignored", async () => {
    setVariations({ [FLAG]: "control", [CATEGORY_FLAG]: "v1" });
    const res = await agent().get("/api/products?category=gear&q=kettle").expect(200);
    expect(res.body.products).toEqual(publicProducts.filter((p) => p.category === "gear"));
  });

  it("v1: price sort orders only the matching products", async () => {
    setVariations({ [FLAG]: "v1", [PRICE_SORT_FLAG]: "v1" });
    const res = await agent().get("/api/products?q=e&sort=price-asc").expect(200);
    const expected = publicProducts
      .filter((p) => p.name.toLowerCase().includes("e"))
      .sort((a, b) => a.priceCents - b.priceCents);
    expect(res.body.products).toEqual(expected);
  });

  it("control: price sort orders the whole catalog (q ignored)", async () => {
    setVariations({ [FLAG]: "control", [PRICE_SORT_FLAG]: "v1" });
    const res = await agent().get("/api/products?q=e&sort=price-asc").expect(200);
    expect(res.body.products).toEqual([...publicProducts].sort((a, b) => a.priceCents - b.priceCents));
  });
});

describe("GET /api/storefront productSearch — paired control / v1", () => {
  it("v1: productSearch is true", async () => {
    setVariations({ [FLAG]: "v1" });
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.productSearch).toBe(true);
  });

  it("control: productSearch is false", async () => {
    setVariations({ [FLAG]: "control" });
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.productSearch).toBe(false);
  });

  it("fallback (flag unavailable): productSearch is false", async () => {
    setVariations({});
    const res = await agent().get("/api/storefront").expect(200);
    expect(res.body.productSearch).toBe(false);
  });
});

describe.each(["control", "v1"])("enable-product-search telemetry (%s)", (variation) => {
  beforeEach(() => setVariations({ [FLAG]: variation }));

  it("success: products-loaded then latency, on the flag's session, no error", async () => {
    await agent().get("/api/products?q=kettle").expect(200);
    expect(eventKeys()).toEqual([LOADED, LATENCY]);
    const flagSession = mocks.getVariation.mock.calls.find((c) => c[0] === FLAG)?.[1];
    expect(flagSession).toEqual(expect.any(String));
    for (const call of searchEvents()) expect(call[1]).toBe(flagSession);
    const latency = searchEvents().find((c) => c[0] === LATENCY)!;
    expect(typeof latency[2]).toBe("number");
    expect(latency[2] as number).toBeGreaterThanOrEqual(0);
  });

  it("no-match query still counts as products-loaded", async () => {
    await agent().get("/api/products?q=zzz-no-such-product").expect(200);
    expect(eventKeys()).toEqual([LOADED, LATENCY]);
  });

  it("handler failure: error + latency, no products-loaded, 500", async () => {
    // Fail upstream of the search logic, identically on both arms.
    mocks.getVariation.mockImplementation(async (key: string, _s: string, fallback = "control") => {
      if (key === CATEGORY_FLAG) throw new Error("flag store down");
      return key === FLAG ? variation : fallback;
    });
    await agent().get("/api/products?q=kettle").expect(500);
    expect(eventKeys()).toEqual([ERROR, LATENCY]);
  });
});

describe("enable-product-search: failure inside the v1-only search code", () => {
  it("v1: searchByName throwing -> 500 with error + latency", async () => {
    setVariations({ [FLAG]: "v1" });
    mocks.searchShouldThrow = true;
    await agent().get("/api/products?q=kettle").expect(500);
    expect(eventKeys()).toEqual([ERROR, LATENCY]);
  });

  it("control: never calls searchByName, so the same request succeeds", async () => {
    setVariations({ [FLAG]: "control" });
    mocks.searchShouldThrow = true;
    const res = await agent().get("/api/products?q=kettle").expect(200);
    expect(res.body.products).toEqual(publicProducts);
    expect(eventKeys()).toEqual([LOADED, LATENCY]);
  });
});

describe("enable-product-search: v1 400 telemetry vs control", () => {
  it("v1: repeated q -> 400 emits latency only", async () => {
    setVariations({ [FLAG]: "v1" });
    await agent().get("/api/products?q=a&q=b").expect(400);
    expect(eventKeys()).toEqual([LATENCY]);
  });

  it("control: repeated q -> 200 emits products-loaded + latency", async () => {
    setVariations({ [FLAG]: "control" });
    await agent().get("/api/products?q=a&q=b").expect(200);
    expect(eventKeys()).toEqual([LOADED, LATENCY]);
  });
});
