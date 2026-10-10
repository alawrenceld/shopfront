import { getProduct } from "./catalog.js";

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface CartView {
  lines: Array<CartLine & { name: string; priceCents: number; lineTotalCents: number }>;
  totalCents: number;
}

const carts = new Map<string, CartLine[]>();

export function getCart(sessionId: string): CartLine[] {
  return carts.get(sessionId) ?? [];
}

export function addToCart(sessionId: string, productId: string, quantity: number): CartLine[] {
  const lines = carts.get(sessionId) ?? [];
  const existing = lines.find((l) => l.productId === productId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    lines.push({ productId, quantity });
  }
  carts.set(sessionId, lines);
  return lines;
}

export function setQuantity(sessionId: string, productId: string, quantity: number): CartLine[] {
  if (quantity === 0) return removeFromCart(sessionId, productId);
  const lines = carts.get(sessionId) ?? [];
  const existing = lines.find((l) => l.productId === productId);
  if (existing) {
    existing.quantity = quantity;
  } else {
    lines.push({ productId, quantity });
  }
  carts.set(sessionId, lines);
  return lines;
}

export function removeFromCart(sessionId: string, productId: string): CartLine[] {
  const lines = (carts.get(sessionId) ?? []).filter((l) => l.productId !== productId);
  carts.set(sessionId, lines);
  return lines;
}

export function clearCart(sessionId: string): void {
  carts.delete(sessionId);
}

export function viewCart(sessionId: string): CartView {
  const lines = getCart(sessionId)
    .map((line) => {
      const product = getProduct(line.productId);
      if (!product) return undefined;
      return {
        ...line,
        name: product.name,
        priceCents: product.priceCents,
        lineTotalCents: product.priceCents * line.quantity,
      };
    })
    .filter((l): l is NonNullable<typeof l> => l !== undefined);
  const totalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  return { lines, totalCents };
}
