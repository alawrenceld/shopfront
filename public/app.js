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
}

const listState = { category: "", sort: "" };

async function loadProducts() {
  const params = new URLSearchParams();
  if (listState.category) params.set("category", listState.category);
  if (listState.sort) params.set("sort", listState.sort);
  const qs = params.toString();
  const { products } = await api(qs ? `/api/products?${qs}` : "/api/products");
  const grid = document.getElementById("products");
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
      btn.textContent = "Add to cart";
      btn.addEventListener("click", async () => {
        await api("/api/cart", { method: "POST", body: JSON.stringify({ productId: p.id }) });
        await renderCart();
      });
      card.append(title, desc, price, btn);
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
      label.textContent = `${line.quantity} × ${line.name}`;
      const right = document.createElement("span");
      right.textContent = fmt(line.lineTotalCents);
      const remove = document.createElement("button");
      remove.textContent = "✕";
      remove.addEventListener("click", async () => {
        await api(`/api/cart/${line.productId}`, { method: "DELETE" });
        await renderCart();
      });
      right.append(remove);
      row.append(label, right);
      return row;
    }),
  );
  const total = document.createElement("div");
  total.className = "cart-total";
  total.innerHTML = `<span>Total</span><span>${fmt(cart.totalCents)}</span>`;
  el.append(total);
  document.getElementById("checkout").disabled = cart.lines.length === 0;
}

document.getElementById("checkout").addEventListener("click", async () => {
  const { order } = await api("/api/checkout", { method: "POST" });
  const result = document.getElementById("order-result");
  result.textContent = `Order placed: ${order.id} — ${fmt(order.totalCents)}`;
  result.hidden = false;
  await renderCart();
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

loadStorefront();
loadProducts();
renderCart();
