import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Wishlist UI (#10). The frontend is plain static JS with no DOM test harness,
// so these tests cover (a) the static assets expose the wishlist hooks, and
// (b) the API flows the UI drives: toggling from the listing, adding to cart
// from the wishlist (item stays saved), and stock-limit errors surfacing.
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

let variations: Record<string, string>;

beforeEach(() => {
  variations = { "enable-wishlist": "v1" };
  mocks.getVariation.mockReset();
  mocks.isEnabled.mockReset();
  mocks.trackEvent.mockReset();
  mocks.isEnabled.mockResolvedValue(false);
  mocks.getVariation.mockImplementation(
    async (key: string, _sessionId: string, fallback = "control") => variations[key] ?? fallback,
  );
});

function agent() {
  return request.agent(createApp());
}

const ids = (body: { items: { productId: string }[] }) => body.items.map((i) => i.productId);

describe("wishlist UI static assets", () => {
  it("serves the nav count, wishlist view, empty state, and error region", async () => {
    const res = await agent().get("/").expect(200);
    expect(res.text).toContain('id="main-nav"');
    expect(res.text).toContain('href="#wishlist"');
    expect(res.text).toContain('id="wishlist-count"');
    expect(res.text).toContain('id="wishlist-view"');
    expect(res.text).toContain('id="wishlist-empty"');
    expect(res.text).toMatch(/id="wishlist-empty"[\s\S]*href="#products"/);
    expect(res.text).toContain('id="wishlist-message"');
  });

  it("ships the save toggle and wishlist rendering in app.js", async () => {
    const res = await agent().get("/app.js").expect(200);
    expect(res.text).toContain("createSaveButton");
    expect(res.text).toContain("toggleWishlist");
    expect(res.text).toContain("renderWishlist");
    expect(res.text).toContain("showWishlistMessage");
  });
});

describe("wishlist UI flows", () => {
  it("toggles a product in and out, and the state survives a reload (same session)", async () => {
    const session = agent();
    const saved = await session.post("/api/wishlist").send({ productId: "gear-v60" }).expect(200);
    expect(ids(saved.body)).toEqual(["gear-v60"]);

    // A page reload re-fetches with the same session cookie.
    const reloaded = await session.get("/api/wishlist").expect(200);
    expect(ids(reloaded.body)).toEqual(["gear-v60"]);

    const unsaved = await session.delete("/api/wishlist/gear-v60").expect(200);
    expect(unsaved.body).toEqual({ items: [] });
  });

  it("adding a wishlist item to the cart leaves it in the wishlist", async () => {
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "beans-colombia" }).expect(200);
    const cart = await session.post("/api/cart").send({ productId: "beans-colombia" }).expect(200);
    expect(cart.body.lines).toEqual([expect.objectContaining({ productId: "beans-colombia", quantity: 1 })]);
    const list = await session.get("/api/wishlist").expect(200);
    expect(ids(list.body)).toEqual(["beans-colombia"]);
  });

  it("respects existing stock limits and their error message when inventory tracking is on", async () => {
    variations["enable-inventory-tracking"] = "v1";
    const session = agent();
    await session.post("/api/wishlist").send({ productId: "beans-decaf" }).expect(200);
    // beans-decaf has 2 in stock: two adds succeed, the third is refused.
    await session.post("/api/cart").send({ productId: "beans-decaf" }).expect(200);
    await session.post("/api/cart").send({ productId: "beans-decaf" }).expect(200);
    const refused = await session.post("/api/cart").send({ productId: "beans-decaf" }).expect(400);
    expect(refused.body).toEqual({ error: "insufficient stock" });
    const list = await session.get("/api/wishlist").expect(200);
    expect(ids(list.body)).toEqual(["beans-decaf"]);
  });

  it("returns an error message the UI can show when saving an unknown product", async () => {
    const res = await agent().post("/api/wishlist").send({ productId: "nope" }).expect(404);
    expect(res.body).toEqual({ error: "product not found" });
  });

  it("answers 404 when the wishlist is not served, which keeps the UI hidden", async () => {
    variations = {};
    await agent().get("/api/wishlist").expect(404, { error: "not found" });
  });
});
