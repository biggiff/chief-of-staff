/**
 * Tiny in-process cache for expensive-but-slow-changing reads (role scoring,
 * today's calendar) that otherwise recompute on every single chat turn.
 *
 * Two invalidation signals:
 *  - a monotonic data version bumped on every Compass write (so a cache entry is
 *    dropped the moment anything it depends on changes), and
 *  - a short TTL as a backstop for changes that don't go through our write layer
 *    (e.g. edits made directly in Todoist).
 *
 * In-memory only: a warm serverless instance reuses it across back-to-back
 * messages; a cold start just recomputes once. No cross-instance guarantees are
 * needed — correctness is bounded by the TTL.
 */

let dataVersion = 0;

/** Call on any Compass write to invalidate version-keyed caches. */
export function bumpDataVersion(): void {
  dataVersion++;
}

export function getDataVersion(): number {
  return dataVersion;
}

type Entry<T> = { version: number; at: number; value: T };
const store = new Map<string, Entry<unknown>>();

/**
 * Memoize an async producer under `key`, keyed on the current data version with
 * a TTL backstop. A write (bumpDataVersion) or TTL expiry forces a recompute.
 */
export async function cached<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.version === dataVersion && Date.now() - hit.at < ttlMs) {
    return hit.value;
  }
  const value = await produce();
  store.set(key, { version: dataVersion, at: Date.now(), value });
  return value;
}
