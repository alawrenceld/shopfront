import { randomUUID } from "node:crypto";
import type { CartView } from "./cart.js";

export interface Order {
  id: string;
  lines: CartView["lines"];
  totalCents: number;
  placedAt: string;
}

const orders = new Map<string, Order>();

export function placeOrder(cart: CartView): Order {
  const order: Order = {
    id: randomUUID(),
    lines: cart.lines,
    totalCents: cart.totalCents,
    placedAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}
