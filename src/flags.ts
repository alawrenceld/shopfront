import { init, type LDClient, type LDContext } from "@launchdarkly/node-server-sdk";

let clientPromise: Promise<LDClient | undefined> | undefined;

async function getClient(): Promise<LDClient | undefined> {
  if (!process.env.LD_SDK_KEY) return undefined;
  if (!clientPromise) {
    const client = init(process.env.LD_SDK_KEY);
    clientPromise = client
      .waitForInitialization({ timeout: 5 })
      .then(() => client)
      .catch(() => client); // degraded mode: evaluations fall back to defaults
  }
  return clientPromise;
}

export function contextForSession(sessionId: string): LDContext {
  return { kind: "user", key: sessionId };
}

/**
 * Evaluate a boolean feature flag for the given session. Returns false when
 * LaunchDarkly is not configured or unreachable, so the default experience is
 * always the flag-off path.
 */
export async function isEnabled(key: string, sessionId: string): Promise<boolean> {
  const client = await getClient();
  if (!client) return false;
  try {
    return Boolean(await client.variation(key, contextForSession(sessionId), false));
  } catch {
    return false;
  }
}

/**
 * Evaluate a string multivariate feature flag ("control" | "v1" | "v2" | ...)
 * for the given session. Returns the fallback ("control") when LaunchDarkly is
 * not configured, unreachable, or returns a non-string value, so the default
 * experience is always the existing-behavior path. Never throws.
 */
export async function getVariation(
  key: string,
  sessionId: string,
  fallback = "control",
): Promise<string> {
  const client = await getClient();
  if (!client) return fallback;
  try {
    const value = await client.variation(key, contextForSession(sessionId), fallback);
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

export async function closeFlags(): Promise<void> {
  const client = await clientPromise;
  await client?.close();
  clientPromise = undefined;
}
