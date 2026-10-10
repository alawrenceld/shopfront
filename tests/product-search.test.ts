import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Name search on GET /api/products (?q=). The flags module is mocked so the
// combination tests can force enable-category-filter / enable-price-sort to "v1".
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
import { products as catalog, searchByName } from "../src/catalog.js";

const CATEGORY_FLAG = "enable-category-filter";
const PRICE_SORT_FLAG = "enable-price-sort";

// The public product shape: with enable-inventory-tracking on control (the
// default here), the API omits the catalog's `stock` field.
const products = catalog.map(({ stock: _stock, ...p }) => p);

function agent() {
  return request.agent(createApp());
}

function setVariations(variations: Record<string, string>) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key in variations ? variations[key] : fallback,
  );
}

function names(list: { name: string }[]) {
  return list.map((p) => p.name);
}

beforeEach(() => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  setVariations({});
});

describe("searchByName", () => {
  it("matches partial names case-insensitively", () => {
    expect(names(searchByName(products, "COLOMBIA"))).toEqual(["Colombia Huila"]);
    expect(names(searchByName(products, "kEtT"))).toEqual(["Gooseneck Kettle"]);
  });

  it("trims leading and trailing whitespace", () => {
    expect(names(searchByName(products, "  dripper \t"))).toEqual(["Ceramic Dripper"]);
  });

  it("returns everything for an empty or whitespace-only query", () => {
    expect(searchByName(products, "")).toEqual(products);
    expect(searchByName(products, "   ")).toEqual(products);
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchByName(products, "matcha")).toEqual([]);
  });

  it("does not mutate the input list", () => {
    const before = products.map((p) => p.id);
    searchByName(products, "");
    searchByName(products, "e");
    expect(products.map((p) => p.id)).toEqual(before);
  });
});

describe("GET /api/products?q=", () => {
  it("returns the full catalog with no search param (unchanged behavior)", async () => {
    const res = await agent().get("/api/products").expect(200);
    expect(res.body.products).toEqual(products);
  });

  it("returns case-insensitive partial matches", async () => {
    const res = await agent().get("/api/products?q=ETHIO").expect(200);
    expect(names(res.body.products)).toEqual(["Ethiopia Yirgacheffe"]);

    const multi = await agent().get("/api/products?q=er").expect(200);
    expect(multi.body.products).toEqual(products.filter((p) => p.name.toLowerCase().includes("er")));
    expect(multi.body.products.length).toBeGreaterThan(1);
  });

  it("ignores leading and trailing whitespace", async () => {
    const res = await agent().get(`/api/products?q=${encodeURIComponent("  decaf  ")}`).expect(200);
    expect(names(res.body.products)).toEqual(["Sugarcane Decaf"]);
  });

  it("returns all products for an empty query", async () => {
    const res = await agent().get("/api/products?q=").expect(200);
    expect(res.body.products).toEqual(products);
  });

  it("returns all products for a whitespace-only query", async () => {
    const res = await agent().get(`/api/products?q=${encodeURIComponent("   ")}`).expect(200);
    expect(res.body.products).toEqual(products);
  });

  it("returns an empty list when nothing matches", async () => {
    const res = await agent().get("/api/products?q=matcha").expect(200);
    expect(res.body.products).toEqual([]);
  });

  it("rejects a repeated q param with 400", async () => {
    const res = await agent().get("/api/products?q=kettle&q=dripper").expect(400);
    expect(res.body.error).toBe("invalid search query");
  });

  describe("combined with the category filter (enable-category-filter v1)", () => {
    beforeEach(() => setVariations({ [CATEGORY_FLAG]: "v1" }));

    it("searches within the chosen category", async () => {
      // "colombia" only appears in a bean's name; searching gear finds nothing.
      const beans = await agent().get("/api/products?category=beans&q=e").expect(200);
      expect(beans.body.products).toEqual(
        products.filter((p) => p.category === "beans" && p.name.toLowerCase().includes("e")),
      );
      expect(beans.body.products.every((p: { category: string }) => p.category === "beans")).toBe(true);

      const gear = await agent().get("/api/products?category=gear&q=colombia").expect(200);
      expect(gear.body.products).toEqual([]);
    });

    it("an empty query within a category returns the whole category", async () => {
      const res = await agent().get("/api/products?category=gear&q=%20").expect(200);
      expect(res.body.products).toEqual(products.filter((p) => p.category === "gear"));
    });

    it("an unknown category still 400s", async () => {
      const res = await agent().get("/api/products?category=snacks&q=kettle").expect(400);
      expect(res.body.error).toBe("unknown category");
    });
  });

  describe("combined with price sort (enable-price-sort v1)", () => {
    beforeEach(() => setVariations({ [PRICE_SORT_FLAG]: "v1" }));

    const matching = () => products.filter((p) => p.name.toLowerCase().includes("e"));

    it("keeps results in ascending price order", async () => {
      const res = await agent().get("/api/products?q=E&sort=price-asc").expect(200);
      expect(res.body.products.length).toBeGreaterThan(1);
      expect(res.body.products).toEqual([...matching()].sort((a, b) => a.priceCents - b.priceCents));
    });

    it("keeps results in descending price order", async () => {
      const res = await agent().get("/api/products?q=e&sort=price-desc").expect(200);
      expect(res.body.products).toEqual([...matching()].sort((a, b) => b.priceCents - a.priceCents));
    });
  });

  it("combines search, category filter, and price sort", async () => {
    setVariations({ [CATEGORY_FLAG]: "v1", [PRICE_SORT_FLAG]: "v1" });
    const res = await agent().get("/api/products?category=gear&q=E&sort=price-desc").expect(200);
    const expected = products
      .filter((p) => p.category === "gear" && p.name.toLowerCase().includes("e"))
      .sort((a, b) => b.priceCents - a.priceCents);
    expect(expected.length).toBeGreaterThan(1);
    expect(res.body.products).toEqual(expected);
  });
});
