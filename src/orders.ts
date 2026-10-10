import { randomUUID } from "node:crypto";
import type { CartView } from "./cart.js";

export interface OrderDiscount {
  code: string;
  discountCents: number;
}

export interface Order {
  id: string;
  lines: CartView["lines"];
  subtotalCents: number;
  discountCents: number;
  discountCode?: string;
  totalCents: number;
  placedAt: string;
}

const orders = new Map<string, Order>();

export function placeOrder(cart: CartView, discount?: OrderDiscount): Order {
  const subtotalCents = cart.totalCents;
  const discountCents = discount?.discountCents ?? 0;
  const order: Order = {
    id: randomUUID(),
    lines: cart.lines,
    subtotalCents,
    discountCents,
    discountCode: discount?.code,
    totalCents: subtotalCents - discountCents,
    placedAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}
