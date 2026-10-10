import { setTimeout as sleep } from "node:timers/promises";
import type { CartLine } from "./cart.js";

export class SupplierTimeoutError extends Error {
  constructor(public readonly productId: string) {
    super(`supplier verification timed out for ${productId}`);
    this.name = "SupplierTimeoutError";
  }
}

export const DEFAULT_VERIFY_DELAY_MS = 350;
// Below the feed's slowest nominal response (1.5 x 350 = 525ms) so the slow
// tail genuinely times out and exercises the retry / fail-closed path.
export const DEFAULT_VERIFY_TIMEOUT_MS = 500;

/**
 * Read a millisecond setting from the environment. Anything that is not a
 * finite number >= 0 (unset, blank, non-numeric, negative) falls back to the
 * default, so a misconfiguration can neither 503 every checkout (blank -> 0)
 * nor silently disable the timeout (NaN comparisons are always false).
 */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function supplierConfig(): { delayMs: number; timeoutMs: number } {
  return {
    delayMs: envMs("SUPPLIER_VERIFY_DELAY_MS", DEFAULT_VERIFY_DELAY_MS),
    timeoutMs: envMs("SUPPLIER_VERIFY_TIMEOUT_MS", DEFAULT_VERIFY_TIMEOUT_MS),
  };
}

async function verifyLine(line: CartLine): Promise<void> {
  // The supplier feed's response time varies between 0.5x and 1.5x its nominal
  // latency. We wait no longer than the timeout; a slower response is a timeout.
  const { delayMs, timeoutMs } = supplierConfig();
  const latencyMs = delayMs * (0.5 + Math.random());
  await sleep(Math.min(latencyMs, timeoutMs));
  if (latencyMs > timeoutMs) {
    throw new SupplierTimeoutError(line.productId);
  }
}

async function verifyLineWithRetry(line: CartLine): Promise<void> {
  try {
    await verifyLine(line);
  } catch (err) {
    if (!(err instanceof SupplierTimeoutError)) throw err;
    await verifyLine(line);
  }
}

/**
 * Verify each cart line against the supplier's stock feed before an order is
 * committed. Lines are verified in parallel, each with one retry on timeout,
 * so the total wait is bounded by ~2x the timeout regardless of cart size. A
 * second timeout on any line fails the verification so checkout can fail
 * closed rather than sell stock the supplier cannot confirm.
 */
export async function verifyStockWithSupplier(lines: CartLine[]): Promise<void> {
  await Promise.all(lines.map((line) => verifyLineWithRetry(line)));
}
