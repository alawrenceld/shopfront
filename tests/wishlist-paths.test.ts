import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type express from "express";

// Flag-path tests for `enable-wishlist` (string multivariate: "control" | "v1").
// Each wrapped route (GET/POST /api/wishlist, DELETE /api/wishlist/:productId)
// is exercised as paired control / v1 cases, plus the guarded-release telemetry
// (item-added / error / latency) emitted on both arms. Complements
// wishlist.test.ts, which covers v1 product behavior in depth.
const mocks = vi.hoisted(() => ({
  getVariation: vi.fn(),
  isEnabled: vi.fn(),
  trackEvent: vi.fn(),
  viewShouldThrow: false,
}));

vi.mock("../src/flags.js", () => ({
  getVariation: mocks.getVariation,
  isEnabled: mocks.isEnabled,
  trackEvent: mocks.trackEvent,
  contextForSession: (sessionId: string) => ({ kind: "user", key: sessionId }),
  closeFlags: async () => {},
}));

// Pass-through wishlist module with a switch to force the v1-only code to fail.
vi.mock("../src/wishlist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/wishlist.js")>();
  return {
    ...actual,
    viewWishlist: (...args: Parameters<typeof actual.viewWishlist>) => {
      if (mocks.viewShouldThrow) throw new Error("wishlist exploded");
      return actual.viewWishlist(...args);
    },
  };
});

const FLAG = "enable-wishlist";
const ADDED = "enable-wishlist-item-added";
const ERROR = "enable-wishlist-error";
const LATENCY = "enable-wishlist-latency";

let app: express.Express;
let wishlist: typeof import("../src/wishlist.js");

function agent() {
  return request.agent(app);
}

function setVariations(variations: Record<string, string>) {
  mocks.getVariation.mockImplementation(async (key: string, _sessionId: string, fallback = "control") =>
    key in variations ? variations[key] : fallback,
  );
}

function wishlistEvents(): unknown[][] {
  return mocks.trackEvent.mock.calls.filter((c) => String(c[0]).startsWith("enable-wishlist-"));
}

function eventKeys(): string[] {
  return wishlistEvents().map((c) => c[0] as string);
}

function flagSession(): string | undefined {
  return mocks.getVariation.mock.calls.find((c) => c[0] === FLAG)?.[1] as string | undefined;
}

function ids(body: { items: { productId: string }[] }) {
  return body.items.map((i) => i.productId);
}

beforeEach(async () => {
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  mocks.viewShouldThrow = false;
  vi.resetModules();
  const { createApp } = await import("../src/server.js");
  wishlist = await import("../src/wishlist.js");
  app = createApp();
});

describe("GET /api/wishlist — paired control / v1", () => {
  it("v1: returns the session's wishlist (200)", async () => {
    setVariations({ [FLAG]: "v1" });
    await agent().get("/api/wishlist").expect(200, { items: [] });
  });

  it("control: 404 not found", async () => {
    setVariations({ [FLAG]: "control" });
    await agent().get("/api/wishlist").expect(404, { error: "not found" });
  });

  it("an unexpected variation (v2) is treated as control", async () => {
    setVariations({ [FLAG]: "v2" });
    await agent().get("/api/wishlist").expect(404, { error: "not found" });
  });

  it("flag unavailable (fallback) behaves like control", async () => {
    setVariations({});
    await agent().get("/api/wishlist").expect(404, { error: "not found" });
    expect(mocks.getVariation).toHaveBeenCalledWith(FLAG, expect.any(String), "control");
  });

  it("v1: product IDs no longer in the catalog are dropped from the response", async () => {
    setVariations({ [FLAG]: "v1" });
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "gear-kettle" }).expect(200);
    const sid = flagSession()!;
    wishlist.addToWishlist(sid, "discontinued-product");
    expect(wishlist.getWishlist(sid)).toEqual(["gear-kettle", "discontinued-product"]);
    const res = await session.get("/api/wishlist").expect(200);
    expect(ids(res.body)).toEqual(["gear-kettle"]);
  });

  it("control: the same session's stored wishlist is not exposed", async () => {
    setVariations({ [FLAG]: "v1" });
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "gear-kettle" }).expect(200);
    setVariations({ [FLAG]: "control" });
    await session.get("/api/wishlist").expect(404, { error: "not found" });
  });
});

describe("POST /api/wishlist — paired control / v1", () => {
  it("v1: adds a known product (200)", async () => {
    setVariations({ [FLAG]: "v1" });
    const res = await agent().post("/api/wishlist").send({ productId: "gear-kettle" }).expect(200);
    expect(ids(res.body)).toEqual(["gear-kettle"]);
  });

  it("control: 404 not found and nothing is stored", async () => {
    setVariations({ [FLAG]: "control" });
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "gear-kettle" }).expect(404, { error: "not found" });
    const sid = flagSession()!;
    expect(wishlist.getWishlist(sid)).toEqual([]);
  });

  it("v1: missing productId -> 400", async () => {
    setVariations({ [FLAG]: "v1" });
    await agent().post("/api/wishlist").send({}).expect(400, { error: "productId is required" });
  });

  it("control: missing productId -> 404 before validation", async () => {
    setVariations({ [FLAG]: "control" });
    await agent().post("/api/wishlist").send({}).expect(404, { error: "not found" });
  });

  it("v1: unknown product -> 404 product not found", async () => {
    setVariations({ [FLAG]: "v1" });
    await agent().post("/api/wishlist").send({ productId: "nope" }).expect(404, { error: "product not found" });
  });

  it("v2 (unexpected variation): behaves like control and stores nothing", async () => {
    setVariations({ [FLAG]: "v2" });
    await agent().post("/api/wishlist").send({ productId: "gear-kettle" }).expect(404, { error: "not found" });
    expect(wishlist.getWishlist(flagSession()!)).toEqual([]);
  });
});

describe("DELETE /api/wishlist/:productId — paired control / v1", () => {
  it("v1: removes the product (200)", async () => {
    setVariations({ [FLAG]: "v1" });
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "gear-kettle" }).expect(200);
    await session.delete("/api/wishlist/gear-kettle").expect(200, { items: [] });
  });

  it("control: 404 not found and the stored wishlist is untouched", async () => {
    setVariations({ [FLAG]: "v1" });
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "gear-kettle" }).expect(200);
    setVariations({ [FLAG]: "control" });
    await session.delete("/api/wishlist/gear-kettle").expect(404, { error: "not found" });
    expect(wishlist.getWishlist(flagSession()!)).toEqual(["gear-kettle"]);
  });

  it("v2 (unexpected variation): behaves like control", async () => {
    setVariations({ [FLAG]: "v2" });
    await agent().delete("/api/wishlist/gear-kettle").expect(404, { error: "not found" });
  });
});

type Route = { name: string; send: (a: ReturnType<typeof agent>) => request.Test };
const routes: Route[] = [
  { name: "GET /api/wishlist", send: (a) => a.get("/api/wishlist") },
  { name: "POST /api/wishlist", send: (a) => a.post("/api/wishlist").send({ productId: "gear-kettle" }) },
  { name: "DELETE /api/wishlist/:productId", send: (a) => a.delete("/api/wishlist/gear-kettle") },
];

describe.each(["control", "v1"])("enable-wishlist latency telemetry (%s)", (variation) => {
  beforeEach(() => setVariations({ [FLAG]: variation }));

  it.each(routes)("$name emits latency on the flag's session context", async ({ send }) => {
    await send(agent()).expect(variation === "v1" ? 200 : 404);
    const latency = wishlistEvents().filter((c) => c[0] === LATENCY);
    expect(latency).toHaveLength(1);
    expect(latency[0][1]).toBe(flagSession());
    expect(typeof latency[0][2]).toBe("number");
    expect(latency[0][2] as number).toBeGreaterThanOrEqual(0);
    expect(eventKeys()).not.toContain(ERROR);
  });
});

describe.each(["control", "v1"])("enable-wishlist error telemetry (%s)", (variation) => {
  it.each(routes)("$name: getVariation rejecting -> 500 with error + latency, no item-added", async ({ send }) => {
    mocks.getVariation.mockImplementation(async (key: string, _s: string, fallback = "control") => {
      if (key === FLAG) throw new Error("flag store down");
      return fallback;
    });
    void variation; // failure occurs before the variation is known, identically on both arms
    await send(agent()).expect(500);
    expect(eventKeys()).toEqual([ERROR, LATENCY]);
    const sid = mocks.getVariation.mock.calls.find((c) => c[0] === FLAG)?.[1];
    for (const call of wishlistEvents()) expect(call[1]).toBe(sid);
  });
});

describe("enable-wishlist: failure inside v1-only code", () => {
  it.each(routes)("v1: $name with viewWishlist throwing -> 500 with error + latency", async ({ send }) => {
    setVariations({ [FLAG]: "v1" });
    mocks.viewShouldThrow = true;
    await send(agent()).expect(500);
    expect(eventKeys()).toEqual([ERROR, LATENCY]);
  });

  it.each(routes)("control: $name never reaches viewWishlist, so it 404s cleanly", async ({ send }) => {
    setVariations({ [FLAG]: "control" });
    mocks.viewShouldThrow = true;
    await send(agent()).expect(404, { error: "not found" });
    expect(eventKeys()).toEqual([LATENCY]);
  });
});

describe("enable-wishlist item-added telemetry — paired control / v1", () => {
  it("v1: successful POST emits item-added then latency on the flag's session", async () => {
    setVariations({ [FLAG]: "v1" });
    await agent().post("/api/wishlist").send({ productId: "gear-kettle" }).expect(200);
    expect(eventKeys()).toEqual([ADDED, LATENCY]);
    for (const call of wishlistEvents()) expect(call[1]).toBe(flagSession());
  });

  it("control: the same POST (404) emits latency only", async () => {
    setVariations({ [FLAG]: "control" });
    await agent().post("/api/wishlist").send({ productId: "gear-kettle" }).expect(404);
    expect(eventKeys()).toEqual([LATENCY]);
  });

  it("v1: 400 (missing productId) does not emit item-added", async () => {
    setVariations({ [FLAG]: "v1" });
    await agent().post("/api/wishlist").send({}).expect(400);
    expect(eventKeys()).toEqual([LATENCY]);
  });

  it("v1: 404 (unknown product) does not emit item-added", async () => {
    setVariations({ [FLAG]: "v1" });
    await agent().post("/api/wishlist").send({ productId: "nope" }).expect(404);
    expect(eventKeys()).toEqual([LATENCY]);
  });

  it("v1: GET and DELETE never emit item-added", async () => {
    setVariations({ [FLAG]: "v1" });
    const session = agent();
    await session.get("/api/wishlist").expect(200);
    await session.delete("/api/wishlist/gear-kettle").expect(200);
    expect(eventKeys()).toEqual([LATENCY, LATENCY]);
  });
});
