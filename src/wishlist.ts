import { getProduct, type Product } from "./catalog.js";
import { remainingStock } from "./inventory.js";

export interface WishlistItem {
  productId: string;
  name: string;
  priceCents: number;
  category: Product["category"];
  inStock: boolean;
}

export interface WishlistView {
  items: WishlistItem[];
}

// Product IDs per session, in the order they were added. Wishlisting never
// touches inventory — it only reads remaining stock to report availability.
const wishlists = new Map<string, string[]>();

export function getWishlist(sessionId: string): string[] {
  return wishlists.get(sessionId) ?? [];
}

/** Add a product to the session's wishlist. Adding one already present is a no-op. */
export function addToWishlist(sessionId: string, productId: string): string[] {
  const ids = wishlists.get(sessionId) ?? [];
  if (!ids.includes(productId)) ids.push(productId);
  wishlists.set(sessionId, ids);
  return ids;
}

/** Remove a product from the session's wishlist. Removing one not present is a no-op. */
export function removeFromWishlist(sessionId: string, productId: string): string[] {
  const ids = (wishlists.get(sessionId) ?? []).filter((id) => id !== productId);
  wishlists.set(sessionId, ids);
  return ids;
}

export function viewWishlist(sessionId: string): WishlistView {
  const items = getWishlist(sessionId)
    .map((productId) => {
      const product = getProduct(productId);
      if (!product) return undefined;
      return {
        productId,
        name: product.name,
        priceCents: product.priceCents,
        category: product.category,
        inStock: remainingStock(productId) > 0,
      };
    })
    .filter((i): i is NonNullable<typeof i> => i !== undefined);
  return { items };
}
