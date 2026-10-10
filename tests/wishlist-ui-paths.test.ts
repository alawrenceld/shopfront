import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type express from "express";

// Flag-path tests for the `enable-wishlist` UI wiring added in #13
// (string multivariate: "control" | "v1"; this PR rides "v1").
//  - GET /api/storefront reports `wishlist` = (variation === "v1"), as paired
//    control / v1 cases plus fallback and unexpected-variation cases.
//  - public/app.js only calls loadWishlist() (and so /api/wishlist) when the
//    storefront reports wishlist === true, and only shows the wishlist view
//    on v1. Checked statically and by running the real client functions
//    against minimal stubs.
// The /api/wishlist routes and their telemetry are covered by wishlist-paths.test.ts.
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

const FLAG = "enable-wishlist";

let app: express.Express;

function setVariations(variations: Record<string, string>) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key in variations ? variations[key] : fallback,
  );
}

beforeEach(async () => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  vi.resetModules();
  const { createApp } = await import("../src/server.js");
  app = createApp();
});

describe("GET /api/storefront wishlist — paired control / v1", () => {
  it("v1: reports wishlist true", async () => {
    setVariations({ [FLAG]: "v1" });
    const res = await request(app).get("/api/storefront").expect(200);
    expect(res.body.wishlist).toBe(true);
    expect(mocks.getVariation).toHaveBeenCalledWith(FLAG, expect.any(String), "control");
  });

  it("control: reports wishlist false", async () => {
    setVariations({ [FLAG]: "control" });
    const res = await request(app).get("/api/storefront").expect(200);
    expect(res.body.wishlist).toBe(false);
  });

  it("flag unavailable (fallback) behaves like control: wishlist false", async () => {
    setVariations({});
    const res = await request(app).get("/api/storefront").expect(200);
    expect(res.body.wishlist).toBe(false);
  });

  it("unexpected variation (v2) is treated as control: wishlist false", async () => {
    setVariations({ [FLAG]: "v2" });
    const res = await request(app).get("/api/storefront").expect(200);
    expect(res.body.wishlist).toBe(false);
  });

  it("the wishlist flag does not change other storefront fields", async () => {
    setVariations({ [FLAG]: "control" });
    const control = (await request(app).get("/api/storefront").expect(200)).body;
    setVariations({ [FLAG]: "v1" });
    const v1 = (await request(app).get("/api/storefront").expect(200)).body;
    const { wishlist: _c, ...controlRest } = control;
    const { wishlist: _v, ...v1Rest } = v1;
    expect(v1Rest).toEqual(controlRest);
  });

  it.each(["control", "v1"])("%s: storefront emits no enable-wishlist telemetry", async (variation) => {
    setVariations({ [FLAG]: variation });
    await request(app).get("/api/storefront").expect(200);
    const wishlistEvents = mocks.trackEvent.mock.calls.filter((c) => String(c[0]).startsWith("enable-wishlist-"));
    expect(wishlistEvents).toEqual([]);
  });
});

// --- Client gating (public/app.js) ---------------------------------------

const appJsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/app.js");
const appJs = readFileSync(appJsPath, "utf8");

/** Extract a top-level function declaration's source from app.js. */
function extractFunction(name: string): string {
  const start = appJs.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  const end = appJs.indexOf("\n}\n", start);
  return appJs.slice(start, end + 2);
}

function fakeEl() {
  return {
    hidden: true,
    textContent: "",
    classList: { toggle: vi.fn() },
    dataset: {} as Record<string, string>,
  };
}

/** Run the real loadStorefront() with stubbed api/document/helpers. */
async function runLoadStorefront(info: Record<string, unknown>) {
  const flagState = {
    cartQuantityEditing: false,
    inventoryTracking: false,
    supplierStockVerification: false,
    productSearch: false,
    wishlist: false,
  };
  const els: Record<string, ReturnType<typeof fakeEl>> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= fakeEl()),
    querySelector: (sel: string) => (els[sel] ??= fakeEl()),
  };
  const api = vi.fn(async () => info);
  const loadWishlist = vi.fn(async () => {});
  const renderCart = vi.fn(async () => {});
  const loadProducts = vi.fn(async () => {});
  const factory = new Function(
    "api",
    "document",
    "flagState",
    "loadWishlist",
    "renderCart",
    "loadProducts",
    `${extractFunction("loadStorefront")}\nreturn loadStorefront;`,
  );
  const loadStorefront = factory(api, document, flagState, loadWishlist, renderCart, loadProducts);
  await loadStorefront();
  return { flagState, loadWishlist, api };
}

const baseInfo = { name: "Shopfront", tagline: "t", promoBanner: null };

describe("app.js loadStorefront wishlist gating — paired control / v1", () => {
  it("v1 (wishlist: true): sets flagState.wishlist and loads the wishlist once", async () => {
    const { flagState, loadWishlist } = await runLoadStorefront({ ...baseInfo, wishlist: true });
    expect(flagState.wishlist).toBe(true);
    expect(loadWishlist).toHaveBeenCalledTimes(1);
  });

  it("control (wishlist: false): never loads the wishlist", async () => {
    const { flagState, loadWishlist } = await runLoadStorefront({ ...baseInfo, wishlist: false });
    expect(flagState.wishlist).toBe(false);
    expect(loadWishlist).not.toHaveBeenCalled();
  });

  it("field missing (older server): treated as control", async () => {
    const { flagState, loadWishlist } = await runLoadStorefront({ ...baseInfo });
    expect(flagState.wishlist).toBe(false);
    expect(loadWishlist).not.toHaveBeenCalled();
  });

  it("truthy non-boolean (\"v1\" string) is not accepted — strict === true", async () => {
    const { flagState, loadWishlist } = await runLoadStorefront({ ...baseInfo, wishlist: "v1" });
    expect(flagState.wishlist).toBe(false);
    expect(loadWishlist).not.toHaveBeenCalled();
  });
});

describe("app.js static wishlist gating", () => {
  it("flagState defaults wishlist to false (control experience)", () => {
    expect(appJs).toMatch(/const flagState = \{[\s\S]*?wishlist: false,[\s\S]*?\};/);
  });

  it("loadWishlist() is only called inside the info.wishlist === true branch", () => {
    const calls = [...appJs.matchAll(/await loadWishlist\(\)|loadWishlist\(\);/g)];
    expect(calls).toHaveLength(1);
    const body = extractFunction("loadStorefront");
    expect(body).toMatch(/if \(info\.wishlist === true\) \{\s*flagState\.wishlist = true;\s*await loadWishlist\(\);\s*\}/);
  });

  it("there is no top-level loadWishlist() call at page load", () => {
    const topLevelCalls = appJs.split("\n").filter((line) => /^loadWishlist\(/.test(line));
    expect(topLevelCalls).toEqual([]);
  });

  it("/api/wishlist is only fetched from loadWishlist / toggleWishlist", () => {
    const fns = ["loadWishlist", "toggleWishlist"].map(extractFunction).join("\n");
    // Count string-literal URLs only (comments also mention the route).
    const literal = /["'`]\/api\/wishlist/g;
    const total = appJs.match(literal)?.length ?? 0;
    const inside = fns.match(literal)?.length ?? 0;
    expect(total).toBeGreaterThan(0);
    expect(inside).toBe(total);
  });
});

/** Run the real showView() with stubbed state. */
function runShowView(opts: { flag: boolean; available: boolean; hash: string }) {
  const els: Record<string, ReturnType<typeof fakeEl>> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= fakeEl()),
    querySelectorAll: () => [] as unknown[],
  };
  const factory = new Function(
    "document",
    "flagState",
    "wishlistState",
    "location",
    `${extractFunction("showView")}\nreturn showView;`,
  );
  const showView = factory(
    document,
    { wishlist: opts.flag },
    { available: opts.available },
    { hash: opts.hash },
  );
  showView();
  return { productsHidden: els["products-view"].hidden, wishlistHidden: els["wishlist-view"].hidden };
}

describe("app.js showView wishlist gating — paired control / v1", () => {
  it("v1 with #wishlist: shows the wishlist view and hides products", () => {
    expect(runShowView({ flag: true, available: true, hash: "#wishlist" })).toEqual({
      productsHidden: true,
      wishlistHidden: false,
    });
  });

  it("control with #wishlist: products stay visible, wishlist view stays hidden", () => {
    expect(runShowView({ flag: false, available: true, hash: "#wishlist" })).toEqual({
      productsHidden: false,
      wishlistHidden: true,
    });
  });

  it("v1 while the API is unavailable (404): wishlist view stays hidden", () => {
    expect(runShowView({ flag: true, available: false, hash: "#wishlist" })).toEqual({
      productsHidden: false,
      wishlistHidden: true,
    });
  });

  it("v1 without #wishlist: products view is shown", () => {
    expect(runShowView({ flag: true, available: true, hash: "#products" })).toEqual({
      productsHidden: false,
      wishlistHidden: true,
    });
  });
});
