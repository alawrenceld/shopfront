import { setTimeout as sleep } from "node:timers/promises";
import type { CartLine } from "./cart.js";

export class SupplierTimeoutError extends Error {
  constructor(public readonly productId: string) {
    super(`supplier verification timed out for ${productId}`);
    this.name = "SupplierTimeoutError";
  }
}

function verifyDelayMs(): number {
  return Number(process.env.SUPPLIER_VERIFY_DELAY_MS ?? 350);
}

function verifyTimeoutMs(): number {
  return Number(process.env.SUPPLIER_VERIFY_TIMEOUT_MS ?? 600);
}

async function verifyLine(line: CartLine): Promise<void> {
  // The supplier feed's response time varies between 0.5x and 1.5x its nominal
  // latency. We wait no longer than the timeout; a slower response is a timeout.
  const latencyMs = verifyDelayMs() * (0.5 + Math.random());
  const timeoutMs = verifyTimeoutMs();
  await sleep(Math.min(latencyMs, timeoutMs));
  if (latencyMs > timeoutMs) {
    throw new SupplierTimeoutError(line.productId);
  }
}

/**
 * Verify each cart line against the supplier's stock feed before an order is
 * committed. Lines are verified sequentially, with one retry per line on
 * timeout; a second timeout fails the verification so checkout can fail
 * closed rather than sell stock the supplier cannot confirm.
 */
export async function verifyStockWithSupplier(lines: CartLine[]): Promise<void> {
  for (const line of lines) {
    try {
      await verifyLine(line);
    } catch (err) {
      if (!(err instanceof SupplierTimeoutError)) throw err;
      await verifyLine(line);
    }
  }
}
