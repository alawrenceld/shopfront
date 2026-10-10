import { products } from "./catalog.js";
import type { CartLine } from "./cart.js";

const stockLevels = new Map<string, number>(products.map((p) => [p.id, p.stock]));

export function remainingStock(productId: string): number {
  return stockLevels.get(productId) ?? 0;
}

export interface Shortage {
  productId: string;
  requested: number;
  available: number;
}

/**
 * Atomically commit an order against inventory: validate every line first,
 * then decrement. Returns the shortages (and decrements nothing) when any
 * line exceeds remaining stock.
 */
export function commitOrder(lines: CartLine[]): Shortage[] {
  const shortages = lines
    .filter((l) => l.quantity > remainingStock(l.productId))
    .map((l) => ({
      productId: l.productId,
      requested: l.quantity,
      available: remainingStock(l.productId),
    }));
  if (shortages.length > 0) return shortages;
  for (const l of lines) {
    stockLevels.set(l.productId, remainingStock(l.productId) - l.quantity);
  }
  return [];
}
