const fmt = (cents) => `$${(cents / 100).toFixed(2)}`;

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}

async function loadStorefront() {
  const info = await api("/api/storefront");
  document.getElementById("tagline").textContent = info.tagline;
  const promo = document.getElementById("promo");
  if (info.promoBanner) {
    promo.textContent = info.promoBanner;
    promo.hidden = false;
  }
  // enable-category-filter: server sends categoryFilter = (variation === "v1")
  if (info.categoryFilter === true) {
    document.getElementById("filters").hidden = false;
  }
  // enable-price-sort: server sends priceSort = (variation === "v1")
  if (info.priceSort === true) {
    document.querySelector(".sort-row").hidden = false;
  }
  // enable-discount-codes: server sends discountCodes = (variation === "v1")
  if (info.discountCodes === true) {
    document.getElementById("discount").hidden = false;
  }
  // enable-cart-quantity-editing: server sends cartQuantityEditing = (variation === "v1").
  // renderCart() runs concurrently on page load, so re-render once we learn the
  // treatment is on; on control nothing changes (no extra render).
  if (info.cartQuantityEditing === true) {
    flagState.cartQuantityEditing = true;
    await renderCart();
  }
  // enable-inventory-tracking: server sends inventoryTracking = (variation === "v1").
  // loadProducts() runs concurrently on page load, so re-render once we learn the
  // treatment is on; on control nothing changes (no extra render).
  if (info.inventoryTracking === true) {
    flagState.inventoryTracking = true;
    await loadProducts();
  }
  // enable-supplier-stock-verification: server sends supplierStockVerification =
  // (variation === "v1"). Only v1 disables Checkout while a request is in flight.
  if (info.supplierStockVerification === true) {
    flagState.supplierStockVerification = true;
  }
  // enable-product-search: server sends productSearch = (variation === "v1").
  // Only v1 shows the search box and the no-results message.
  if (info.productSearch === true) {
    flagState.productSearch = true;
    document.getElementById("search-form").hidden = false;
  }
  // enable-wishlist: server sends wishlist = (variation === "v1").
  // Only v1 loads the wishlist (save buttons, nav, wishlist view). Control never
  // calls /api/wishlist, so it can never see the wishlist error banner.
  if (info.wishlist === true) {
    flagState.wishlist = true;
    await loadWishlist();
  }
}

// Flag state learned from /api/storefront; defaults are the control experience.
const flagState = {
  cartQuantityEditing: false,
  inventoryTracking: false,
  supplierStockVerification: false,
  productSearch: false,
  wishlist: false,
};

const listState = { category: "", sort: "", q: "" };

async function loadProducts() {
  const params = new URLSearchParams();
  if (listState.category) params.set("category", listState.category);
  if (listState.sort) params.set("sort", listState.sort);
  if (listState.q) params.set("q", listState.q);
  const qs = params.toString();
  const { products } = await api(qs ? `/api/products?${qs}` : "/api/products");
  const grid = document.getElementById("products");
  // enable-product-search: the no-results message is v1-only (control stays
  // pixel-identical to pre-PR behavior).
  document.getElementById("no-results").hidden = !(flagState.productSearch === true && products.length === 0);
  grid.replaceChildren(
    ...products.map((p) => {
      const card = document.createElement("div");
      card.className = "card";
      const title = document.createElement("h3");
      title.textContent = p.name;
      const desc = document.createElement("p");
      desc.textContent = p.description;
      const price = document.createElement("span");
      price.className = "price";
      price.textContent = fmt(p.priceCents);
      const btn = document.createElement("button");
      // enable-inventory-tracking: only "v1" renders stock UI (the server also
      // omits `stock` on control, so this is belt-and-braces).
      const inventoryTracking = flagState.inventoryTracking === true && typeof p.stock === "number";
      if (inventoryTracking && p.stock === 0) {
        btn.textContent = "Out of stock";
        btn.disabled = true;
      } else {
        btn.textContent = "Add to cart";
        btn.addEventListener("click", async () => {
          await api("/api/cart", { method: "POST", body: JSON.stringify({ productId: p.id }) });
          await renderCart();
        });
      }
      card.append(title, desc, price);
      if (inventoryTracking && p.stock > 0 && p.stock <= 3) {
        const low = document.createElement("span");
        low.className = "low-stock";
        low.textContent = `Only ${p.stock} left`;
        card.append(low);
      }
      card.append(btn, createSaveButton(p.id));
      return card;
    }),
  );
}

async function renderCart() {
  const cart = await api("/api/cart");
  const el = document.getElementById("cart");
  el.replaceChildren(
    ...cart.lines.map((line) => {
      const row = document.createElement("div");
      row.className = "cart-line";
      const label = document.createElement("span");
      // enable-cart-quantity-editing: only "v1" gets the steppers + name-only label.
      const quantityEditing = flagState.cartQuantityEditing === true;
      let qty = null;
      if (quantityEditing) {
        label.textContent = line.name;
        qty = document.createElement("span");
        qty.className = "qty-controls";
        const setQty = async (quantity) => {
          await api(`/api/cart/${line.productId}`, {
            method: "PATCH",
            body: JSON.stringify({ quantity }),
          });
          await renderCart();
        };
        const minus = document.createElement("button");
        minus.textContent = "−";
        minus.addEventListener("click", () => setQty(line.quantity - 1));
        const count = document.createElement("span");
        count.textContent = line.quantity;
        const plus = document.createElement("button");
        plus.textContent = "+";
        plus.addEventListener("click", () => setQty(line.quantity + 1));
        qty.append(minus, count, plus);
      } else {
        label.textContent = `${line.quantity} × ${line.name}`;
      }
      const right = document.createElement("span");
      right.textContent = fmt(line.lineTotalCents);
      const remove = document.createElement("button");
      remove.textContent = "✕";
      remove.addEventListener("click", async () => {
        await api(`/api/cart/${line.productId}`, { method: "DELETE" });
        await renderCart();
      });
      right.append(remove);
      if (quantityEditing) {
        row.append(label, qty, right);
      } else {
        row.append(label, right);
      }
      return row;
    }),
  );
  const total = document.createElement("div");
  total.className = "cart-total";
  total.innerHTML = `<span>Total</span><span>${fmt(cart.totalCents)}</span>`;
  el.append(total);
  document.getElementById("checkout").disabled = cart.lines.length === 0;
}

// Wishlist: saved product IDs and items for this session, as last reported by
// /api/wishlist. `available` stays false while the API answers 404 (the route
// is not served for this session), in which case no wishlist UI is shown.
const wishlistState = { available: false, ids: new Set(), items: [] };

function showWishlistMessage(text) {
  const el = document.getElementById("wishlist-message");
  el.textContent = text;
  el.hidden = false;
}

function clearWishlistMessage() {
  const el = document.getElementById("wishlist-message");
  el.textContent = "";
  el.hidden = true;
}

function createSaveButton(productId) {
  const btn = document.createElement("button");
  btn.className = "save-btn";
  btn.dataset.productId = productId;
  btn.addEventListener("click", () => toggleWishlist(productId));
  syncSaveButton(btn);
  return btn;
}

function syncSaveButton(btn) {
  const saved = wishlistState.ids.has(btn.dataset.productId);
  btn.hidden = !wishlistState.available;
  btn.classList.toggle("saved", saved);
  btn.setAttribute("aria-pressed", String(saved));
  btn.textContent = saved ? "♥ Saved" : "♡ Save";
}

/** Apply a wishlist response to every view: listing buttons, nav count, wishlist view. */
function applyWishlist(view) {
  wishlistState.available = true;
  wishlistState.items = view.items;
  wishlistState.ids = new Set(view.items.map((i) => i.productId));
  document.getElementById("main-nav").hidden = false;
  document.getElementById("wishlist-count").textContent = view.items.length;
  document.querySelectorAll(".save-btn").forEach(syncSaveButton);
  renderWishlist();
}

async function loadWishlist() {
  let res;
  try {
    res = await fetch("/api/wishlist");
  } catch {
    showWishlistMessage("Could not load your wishlist. Please try again.");
    return;
  }
  // 404: the wishlist is not served for this session — keep its UI hidden.
  if (res.status === 404) return;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    showWishlistMessage(body.error ?? "Could not load your wishlist. Please try again.");
    return;
  }
  applyWishlist(await res.json());
  showView();
}

async function toggleWishlist(productId) {
  const saved = wishlistState.ids.has(productId);
  try {
    const view = saved
      ? await api(`/api/wishlist/${encodeURIComponent(productId)}`, { method: "DELETE" })
      : await api("/api/wishlist", { method: "POST", body: JSON.stringify({ productId }) });
    clearWishlistMessage();
    applyWishlist(view);
  } catch (err) {
    showWishlistMessage(`Could not update your wishlist: ${err.message}`);
  }
}

function renderWishlist() {
  const items = wishlistState.items;
  document.getElementById("wishlist-empty").hidden = items.length > 0;
  document.getElementById("wishlist-items").replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("div");
      row.className = "wishlist-item";
      const name = document.createElement("span");
      name.className = "wishlist-name";
      name.textContent = item.name;
      const price = document.createElement("span");
      price.className = "price";
      price.textContent = fmt(item.priceCents);
      const availability = document.createElement("span");
      availability.className = item.inStock ? "availability" : "availability out";
      availability.textContent = item.inStock ? "In stock" : "Out of stock";
      const addToCart = document.createElement("button");
      addToCart.textContent = "Add to cart";
      addToCart.disabled = !item.inStock;
      addToCart.addEventListener("click", async () => {
        // Uses the regular cart endpoint (and its stock checks); the item stays
        // in the wishlist.
        try {
          await api("/api/cart", { method: "POST", body: JSON.stringify({ productId: item.productId }) });
          clearWishlistMessage();
        } catch (err) {
          showWishlistMessage(`Could not add ${item.name} to your cart: ${err.message}`);
        }
        await renderCart();
      });
      const remove = document.createElement("button");
      remove.className = "wishlist-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => toggleWishlist(item.productId));
      const actions = document.createElement("span");
      actions.className = "wishlist-actions";
      actions.append(addToCart, remove);
      row.append(name, price, availability, actions);
      return row;
    }),
  );
}

/** Show the view named by the URL hash (#wishlist), defaulting to products. */
function showView() {
  // enable-wishlist: the wishlist view is v1-only.
  const wishlist = flagState.wishlist === true && wishlistState.available && location.hash === "#wishlist";
  document.getElementById("products-view").hidden = wishlist;
  document.getElementById("wishlist-view").hidden = !wishlist;
  document.querySelectorAll(".main-nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === (wishlist ? "wishlist" : "products"));
  });
}

window.addEventListener("hashchange", showView);

document.getElementById("checkout").addEventListener("click", async () => {
  const result = document.getElementById("order-result");
  const discountInput = document.getElementById("discount");
  const discountCode = discountInput.value.trim();
  // enable-supplier-stock-verification: v1 checkout waits on the supplier, so
  // block double-submits while it runs. Control leaves the button as before.
  const checkoutBtn = document.getElementById("checkout");
  const guardInFlight = flagState.supplierStockVerification === true;
  if (guardInFlight) checkoutBtn.disabled = true;
  try {
    const { order } = await api("/api/checkout", {
      method: "POST",
      body: JSON.stringify(discountCode ? { discountCode } : {}),
    });
    const savings = order.discountCents > 0 ? ` (saved ${fmt(order.discountCents)})` : "";
    result.textContent = `Order placed: ${order.id} — ${fmt(order.totalCents)}${savings}`;
    discountInput.value = "";
    await renderCart();
  } catch (err) {
    result.textContent = err.message;
    // v1: re-render so the button re-enables and any cart change is shown.
    if (guardInFlight) {
      await renderCart().catch(() => {
        checkoutBtn.disabled = false;
      });
    }
  }
  result.hidden = false;
});

document.getElementById("filters").addEventListener("click", async (event) => {
  const btn = event.target.closest(".filter");
  if (!btn) return;
  document.querySelectorAll(".filter").forEach((b) => b.classList.toggle("active", b === btn));
  listState.category = btn.dataset.category;
  await loadProducts();
});

document.getElementById("sort").addEventListener("change", async (event) => {
  listState.sort = event.target.value;
  await loadProducts();
});

// Name search: submitting runs immediately; typing runs after a short debounce.
const SEARCH_DEBOUNCE_MS = 250;
let searchTimer;
async function applySearch() {
  clearTimeout(searchTimer);
  const q = document.getElementById("search").value.trim();
  if (q === listState.q) return;
  listState.q = q;
  await loadProducts();
}

document.getElementById("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applySearch, SEARCH_DEBOUNCE_MS);
});

document.getElementById("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await applySearch();
});

loadStorefront();
loadProducts();
renderCart();
