import {
  IDEMPOTENCY_TTL_MS,
  InMemoryIdempotencyStore,
  type IdempotencyStore,
} from "../middleware/idempotency";
import type { TelemetryLogEntry } from "../middleware/telemetry";

export interface PocketBaseEnv {
  POCKETBASE_URL?: string;
  POCKETBASE_ADMIN_EMAIL?: string;
  POCKETBASE_ADMIN_PASSWORD?: string;
  POCKETBASE_IDEMPOTENCY_COLLECTION?: string;
  POCKETBASE_AUDIT_COLLECTION?: string;
  POCKETBASE_TELEMETRY_COLLECTION?: string;
}

export interface PocketBaseStorageOptions extends PocketBaseEnv {
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}

interface PocketBaseRecord {
  id: string;
  expires_at?: string;
  [key: string]: unknown;
}

interface PocketBaseListResponse {
  items?: PocketBaseRecord[];
}

interface CollectionField {
  name: string;
  type: string;
  required?: boolean;
}

interface CollectionDefinition {
  name: string;
  type: "base";
  fields: CollectionField[];
  indexes?: string[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logStorageError(event: string, error: unknown): void {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      error: describeError(error),
    }),
  );
}

/**
 * PocketBase-backed storage for idempotency and telemetry.
 *
 * Idempotency writes use a unique hash index. If PocketBase is unavailable,
 * reservations fall back to an isolate-local memory store so local development
 * remains usable; the fallback does not provide cross-isolate guarantees.
 */
export class PocketBaseStorage implements IdempotencyStore {
  readonly baseUrl: string;

  private readonly adminEmail: string;
  private readonly adminPassword: string;
  private readonly idempotencyCollection: string;
  private readonly auditCollection: string;
  private readonly telemetryCollection: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly fallbackStore: InMemoryIdempotencyStore;
  private readonly pendingWrites = new Set<Promise<void>>();
  private token: string | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(options: PocketBaseStorageOptions) {
    const baseUrl = options.POCKETBASE_URL?.trim().replace(/\/$/, "");
    if (!baseUrl) {
      throw new Error("POCKETBASE_URL is required");
    }
    if (!options.POCKETBASE_ADMIN_EMAIL || !options.POCKETBASE_ADMIN_PASSWORD) {
      throw new Error(
        "POCKETBASE_ADMIN_EMAIL and POCKETBASE_ADMIN_PASSWORD are required",
      );
    }

    this.baseUrl = baseUrl;
    this.adminEmail = options.POCKETBASE_ADMIN_EMAIL;
    this.adminPassword = options.POCKETBASE_ADMIN_PASSWORD;
    this.idempotencyCollection =
      options.POCKETBASE_IDEMPOTENCY_COLLECTION ?? "idempotency_keys";
    this.auditCollection =
      options.POCKETBASE_AUDIT_COLLECTION ?? "request_audit_logs";
    this.telemetryCollection =
      options.POCKETBASE_TELEMETRY_COLLECTION ?? "telemetry_metrics";
    this.ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl =
      options.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.fallbackStore = new InMemoryIdempotencyStore(this.ttlMs, this.now);

    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive finite number");
    }
  }

  async reserve(hash: string): Promise<boolean> {
    try {
      await this.ensureReady();
      const now = this.now();
      const expiresAt = new Date(now + this.ttlMs).toISOString();
      const existing = await this.findIdempotencyRecord(hash);

      if (existing) {
        const currentExpiry = Date.parse(existing.expires_at ?? "");
        if (Number.isFinite(currentExpiry) && currentExpiry > now) {
          return false;
        }

        const refreshed = await this.request(
          `/api/collections/${this.idempotencyCollection}/records/${existing.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ expires_at: expiresAt }),
          },
        );
        if (!refreshed.ok) {
          throw new Error(`PocketBase refresh failed: ${refreshed.status}`);
        }
        return true;
      }

      const created = await this.request(
        `/api/collections/${this.idempotencyCollection}/records`,
        {
          method: "POST",
          body: JSON.stringify({ hash, expires_at: expiresAt }),
        },
      );

      if (created.ok) {
        return true;
      }
      if (created.status === 400 || created.status === 409) {
        return false;
      }

      throw new Error(`PocketBase idempotency write failed: ${created.status}`);
    } catch (error) {
      logStorageError("pocketbase.idempotency.fallback", error);
      return this.fallbackStore.reserve(hash);
    }
  }

  async clear(): Promise<void> {
    this.fallbackStore.clear();

    try {
      await this.ensureReady();

      while (true) {
        const response = await this.request(
          `/api/collections/${this.idempotencyCollection}/records?perPage=100&page=1`,
          { method: "GET" },
        );
        if (!response.ok) {
          throw new Error(`PocketBase list failed: ${response.status}`);
        }

        const body = (await response.json()) as PocketBaseListResponse;
        const items = body.items ?? [];

        for (const item of items) {
          const deleted = await this.request(
            `/api/collections/${this.idempotencyCollection}/records/${item.id}`,
            { method: "DELETE" },
          );
          if (!deleted.ok && deleted.status !== 404) {
            throw new Error(`PocketBase delete failed: ${deleted.status}`);
          }
        }

        if (items.length < 100) {
          break;
        }
      }
    } catch (error) {
      logStorageError("pocketbase.idempotency.clear.failed", error);
    }
  }

  async recordTelemetryLog(log: TelemetryLogEntry): Promise<void> {
    await this.ensureReady();

    const response = await this.request(
      `/api/collections/${this.telemetryCollection}/records`,
      {
        method: "POST",
        body: JSON.stringify({
          trace_id: log.trace_id,
          span: log.span,
          level: log.level,
          message: log.message,
          status_code: log.statusCode,
          duration_ms: log.durationMs,
          timestamp: log.timestamp,
          attributes: log.attributes,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`PocketBase telemetry write failed: ${response.status}`);
    }

    if (log.span === "request_ingress" && log.message === "request completed") {
      const method =
        typeof log.attributes.method === "string" ? log.attributes.method : "";
      const path =
        typeof log.attributes.path === "string" ? log.attributes.path : "";

      const audit = await this.request(
        `/api/collections/${this.auditCollection}/records`,
        {
          method: "POST",
          body: JSON.stringify({
            trace_id: log.trace_id,
            status_code: log.statusCode,
            duration_ms: log.durationMs,
            method,
            path,
            outcome: log.level,
            timestamp: log.timestamp,
          }),
        },
      );

      if (!audit.ok) {
        throw new Error(`PocketBase audit write failed: ${audit.status}`);
      }
    }
  }

  recordTelemetry(log: TelemetryLogEntry): void {
    const write = this.recordTelemetryLog(log).catch((error) => {
      logStorageError("pocketbase.telemetry.failed", error);
    });
    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write));
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingWrites]);
  }

  private async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize().catch((error) => {
        this.readyPromise = null;
        throw error;
      });
    }
    await this.readyPromise;
  }

  private async initialize(): Promise<void> {
    await this.authenticate();
    await this.ensureCollections();
  }

  private async authenticate(): Promise<void> {
    const paths = [
      "/api/collections/_superusers/auth-with-password",
      "/api/admins/auth-with-password",
    ];

    for (const path of paths) {
      const response = await this.request(
        path,
        {
          method: "POST",
          body: JSON.stringify({
            identity: this.adminEmail,
            password: this.adminPassword,
          }),
        },
        false,
      );

      if (response.ok) {
        const body = (await response.json()) as { token?: string };
        if (body.token) {
          this.token = body.token;
          return;
        }
      }

      if (response.status !== 404) {
        throw new Error(`PocketBase authentication failed: ${response.status}`);
      }
    }

    throw new Error("PocketBase authentication endpoint was not found");
  }

  private async ensureCollections(): Promise<void> {
    await this.ensureCollection({
      name: this.idempotencyCollection,
      type: "base",
      fields: [
        { name: "hash", type: "text", required: true },
        { name: "expires_at", type: "date", required: true },
      ],
      indexes: [
        `CREATE UNIQUE INDEX \`idx_${this.idempotencyCollection}_hash\` ON \`${this.idempotencyCollection}\` (\`hash\`)`,
      ],
    });

    await this.ensureCollection({
      name: this.auditCollection,
      type: "base",
      fields: [
        { name: "trace_id", type: "text", required: true },
        { name: "status_code", type: "number", required: true },
        { name: "duration_ms", type: "number", required: true },
        { name: "method", type: "text" },
        { name: "path", type: "text" },
        { name: "outcome", type: "text" },
        { name: "timestamp", type: "date" },
      ],
    });

    await this.ensureCollection({
      name: this.telemetryCollection,
      type: "base",
      fields: [
        { name: "trace_id", type: "text", required: true },
        { name: "span", type: "text", required: true },
        { name: "level", type: "text", required: true },
        { name: "message", type: "text" },
        { name: "status_code", type: "number" },
        { name: "duration_ms", type: "number" },
        { name: "timestamp", type: "date" },
        { name: "attributes", type: "json" },
      ],
    });
  }

  private async ensureCollection(
    definition: CollectionDefinition,
  ): Promise<void> {
    const path = `/api/collections/${encodeURIComponent(definition.name)}`;
    const existing = await this.request(path, { method: "GET" });
    if (existing.ok) {
      return;
    }
    if (existing.status !== 404) {
      throw new Error(`PocketBase collection lookup failed: ${existing.status}`);
    }

    const created = await this.request("/api/collections", {
      method: "POST",
      body: JSON.stringify(definition),
    });
    if (created.ok) {
      return;
    }

    // Another Worker may have created it between the lookup and create.
    const recheck = await this.request(path, { method: "GET" });
    if (!recheck.ok) {
      throw new Error(
        `PocketBase collection create failed: ${created.status}`,
      );
    }
  }

  private async findIdempotencyRecord(
    hash: string,
  ): Promise<PocketBaseRecord | null> {
    const filter = encodeURIComponent(`hash='${hash}'`);
    const response = await this.request(
      `/api/collections/${this.idempotencyCollection}/records?perPage=1&filter=${filter}`,
      { method: "GET" },
    );
    if (!response.ok) {
      throw new Error(`PocketBase idempotency lookup failed: ${response.status}`);
    }

    const body = (await response.json()) as PocketBaseListResponse;
    return body.items?.[0] ?? null;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    useAuth = true,
  ): Promise<Response> {
    const perform = async (): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      if (useAuth && this.token) {
        headers.set("authorization", this.token);
      }

      return this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    };

    let response = await perform();

    if (response.status === 401 && useAuth) {
      this.token = null;
      await this.authenticate();
      response = await perform();
    }

    return response;
  }
}
