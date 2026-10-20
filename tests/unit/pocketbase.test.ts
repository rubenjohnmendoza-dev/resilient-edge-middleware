import { describe, expect, it } from "vitest";
import { PocketBaseStorage } from "../../src/adapters/pocketbase";
import type { TelemetryLogEntry } from "../../src/middleware/telemetry";

type RecordValue = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakePocketBase {
  readonly collections = new Set<string>();
  readonly records = new Map<string, RecordValue[]>();
  private nextId = 1;

  fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : input;
    const url = new URL(rawUrl, "http://pocketbase");
    const method = init?.method ?? "GET";
    const path = url.pathname;

    if (path.endsWith("/auth-with-password")) {
      return jsonResponse({ token: "test-token" });
    }

    if (method === "POST" && path === "/api/collections") {
      const definition = JSON.parse(String(init?.body)) as {
        name: string;
      };
      this.collections.add(definition.name);
      this.records.set(definition.name, []);
      return jsonResponse(definition, 201);
    }

    const collectionMatch = /^\/api\/collections\/([^/]+)$/.exec(path);
    if (collectionMatch) {
      const name = decodeURIComponent(collectionMatch[1] ?? "");
      return this.collections.has(name)
        ? jsonResponse({ name })
        : jsonResponse({ message: "not found" }, 404);
    }

    const recordsMatch = /^\/api\/collections\/([^/]+)\/records(?:\/([^/]+))?$/.exec(
      path,
    );
    if (!recordsMatch) {
      return jsonResponse({ message: "not found" }, 404);
    }

    const collection = decodeURIComponent(recordsMatch[1] ?? "");
    const recordId = recordsMatch[2]
      ? decodeURIComponent(recordsMatch[2])
      : null;
    const records = this.records.get(collection) ?? [];
    this.records.set(collection, records);

    if (method === "GET" && recordId === null) {
      const filter = url.searchParams.get("filter") ?? "";
      const hashMatch = /hash='([^']+)'/.exec(filter);
      const items = hashMatch
        ? records.filter((record) => record.hash === hashMatch[1])
        : records;
      return jsonResponse({ items: items.slice(0, 1) });
    }

    if (method === "POST" && recordId === null) {
      const payload = JSON.parse(String(init?.body)) as RecordValue;
      if (
        collection === "idempotency_keys" &&
        records.some((record) => record.hash === payload.hash)
      ) {
        return jsonResponse({ message: "unique constraint" }, 400);
      }
      const record = { id: `record-${this.nextId}`, ...payload };
      this.nextId += 1;
      records.push(record);
      return jsonResponse(record, 201);
    }

    const record = records.find((item) => item.id === recordId);
    if (!record) {
      return jsonResponse({ message: "not found" }, 404);
    }

    if (method === "PATCH") {
      Object.assign(record, JSON.parse(String(init?.body)));
      return jsonResponse(record);
    }

    if (method === "DELETE") {
      this.records.set(
        collection,
        records.filter((item) => item.id !== recordId),
      );
      return jsonResponse({ deleted: true });
    }

    return jsonResponse({ message: "method not allowed" }, 405);
  };
}

function createStorage(
  server: FakePocketBase,
  options: { now?: () => number; ttlMs?: number } = {},
): PocketBaseStorage {
  return new PocketBaseStorage({
    POCKETBASE_URL: "http://pocketbase:8090",
    POCKETBASE_ADMIN_EMAIL: "admin@example.com",
    POCKETBASE_ADMIN_PASSWORD: "secret",
    ttlMs: options.ttlMs ?? 1_000,
    now: options.now ?? (() => 1_000),
    fetchImpl: server.fetch,
  });
}

function telemetryLog(
  overrides: Partial<TelemetryLogEntry> = {},
): TelemetryLogEntry {
  return {
    timestamp: "2026-10-20T01:20:00.000Z",
    trace_id: "trace-1",
    span: "idempotency_check",
    level: "info",
    message: "idempotency check passed",
    statusCode: 200,
    durationMs: 2,
    attributes: {},
    ...overrides,
  };
}

describe("PocketBaseStorage", () => {
  it("creates collections and enforces a duplicate idempotency hash", async () => {
    const server = new FakePocketBase();
    const storage = createStorage(server);

    await expect(storage.reserve("hash-one")).resolves.toBe(true);
    await expect(storage.reserve("hash-one")).resolves.toBe(false);

    expect([...server.collections].sort()).toEqual([
      "idempotency_keys",
      "request_audit_logs",
      "telemetry_metrics",
    ]);
    expect(server.records.get("idempotency_keys")).toHaveLength(1);
  });

  it("refreshes an expired idempotency reservation", async () => {
    const server = new FakePocketBase();
    let now = 1_000;
    const storage = createStorage(server, {
      ttlMs: 1_000,
      now: () => now,
    });

    await expect(storage.reserve("hash-ttl")).resolves.toBe(true);
    now = 1_500;
    await expect(storage.reserve("hash-ttl")).resolves.toBe(false);
    now = 2_000;
    await expect(storage.reserve("hash-ttl")).resolves.toBe(true);

    expect(server.records.get("idempotency_keys")).toHaveLength(1);
  });

  it("writes telemetry metrics and request audit logs", async () => {
    const server = new FakePocketBase();
    const storage = createStorage(server);

    await storage.recordTelemetryLog(telemetryLog());
    await storage.recordTelemetryLog(
      telemetryLog({
        span: "request_ingress",
        message: "request completed",
        statusCode: 409,
        level: "warn",
        attributes: { method: "POST", path: "/orders" },
      }),
    );

    expect(server.records.get("telemetry_metrics")).toHaveLength(2);
    expect(server.records.get("request_audit_logs")).toHaveLength(1);
    expect(server.records.get("request_audit_logs")?.[0]).toMatchObject({
      trace_id: "trace-1",
      status_code: 409,
      method: "POST",
      path: "/orders",
      outcome: "warn",
    });
  });
});
