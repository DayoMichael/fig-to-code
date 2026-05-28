import { randomUUID } from "node:crypto";
import type { ResolvedComponentBundle } from "@fig2code/spec";

export interface BundleStoreOptions {
  /** Time-to-live for stored bundles in milliseconds. Defaults to 30 minutes. */
  ttlMs?: number;
  /** Maximum number of entries to retain. Older entries are evicted FIFO. */
  maxEntries?: number;
  /** Override clock for tests. */
  now?: () => number;
}

interface StoredEntry {
  bundle: ResolvedComponentBundle;
  expiresAt: number;
}

export interface BundleStore {
  store(bundle: ResolvedComponentBundle): { bundleId: string; expiresAt: number };
  get(id: string): ResolvedComponentBundle | undefined;
  delete(id: string): void;
  size(): number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;

export function createBundleStore(options: BundleStoreOptions = {}): BundleStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;

  const entries = new Map<string, StoredEntry>();

  function purgeExpired(): void {
    const cutoff = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= cutoff) entries.delete(id);
    }
  }

  function trim(): void {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (!oldestKey) break;
      entries.delete(oldestKey);
    }
  }

  return {
    store(bundle) {
      purgeExpired();
      const bundleId = randomUUID();
      const expiresAt = now() + ttlMs;
      entries.set(bundleId, { bundle, expiresAt });
      trim();
      return { bundleId, expiresAt };
    },

    get(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(id);
        return undefined;
      }
      return entry.bundle;
    },

    delete(id) {
      entries.delete(id);
    },

    size() {
      purgeExpired();
      return entries.size;
    },
  };
}
