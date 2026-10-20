export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const PRUNE_THRESHOLD = 1024;

export interface IdempotencyStore {
  /**
   * Atomically reserves a hash for the configured TTL.
   * Returns true when reserved, false when a live entry already exists.
   */
  reserve(hash: string): boolean | Promise<boolean>;
  clear?(): void | Promise<void>;
}

/**
 * Isolate-local mock store for edge execution and tests.
 *
 * A real deployment should back this with a Durable Object or a SQLite unique
 * constraint so reservations are shared across Worker isolates and regions.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = IDEMPOTENCY_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive finite number");
    }
  }

  reserve(hash: string): boolean {
    const now = this.now();
    const expiresAt = this.entries.get(hash);

    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }

    this.entries.set(hash, now + this.ttlMs);
    this.pruneExpired(now);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpired(now: number): void {
    if (this.entries.size < PRUNE_THRESHOLD) {
      return;
    }

    for (const [hash, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(hash);
      }
    }
  }
}

const defaultStore = new InMemoryIdempotencyStore();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function checkIdempotency(
  _request: Request,
  bodyText: string,
  store: IdempotencyStore = defaultStore,
): Promise<{ isDuplicate: boolean; hash: string }> {
  const hash = await sha256Hex(bodyText);
  const reserved = await store.reserve(hash);

  return {
    isDuplicate: !reserved,
    hash,
  };
}
