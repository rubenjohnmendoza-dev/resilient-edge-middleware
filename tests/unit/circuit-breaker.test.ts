import { describe, expect, it } from "vitest";
import { createWorker } from "../../src/index";
import { CircuitBreaker } from "../../src/middleware/circuit-breaker";
import { InMemoryIdempotencyStore } from "../../src/middleware/idempotency";
import type { IdempotencyStore } from "../../src/middleware/idempotency";
import { TelemetryTracer } from "../../src/middleware/telemetry";

const context = {} as ExecutionContext;

function postRequest(body: string): Request {
  return new Request("https://rem.example/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function validBody(suffix: string): string {
  return JSON.stringify({
    id: "550e8400-e29b-41d4-a716-446655440000",
    amount: 125.5,
    currency: "AUD",
    customerEmail: `customer-${suffix}@example.com`,
    timestamp: "2026-10-20T01:20:00.000Z",
  });
}

function trip(breaker: CircuitBreaker): void {
  breaker.recordFailure(10);
  breaker.recordFailure(10);
  breaker.recordFailure(10);
}

describe("CircuitBreaker", () => {
  it("moves from CLOSED to OPEN when the failure rate exceeds the threshold", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({
      minimumRequests: 3,
      now: () => now,
    });

    breaker.recordFailure(10);
    now += 1;
    breaker.recordFailure(10);
    now += 1;
    expect(breaker.state).toBe("CLOSED");

    breaker.recordFailure(10);
    expect(breaker.state).toBe("OPEN");
  });

  it("opens when a latency sample exceeds the configured threshold", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({
      minimumRequests: 3,
      latencyThresholdMs: 500,
      now: () => now,
    });

    breaker.recordSuccess(100);
    now += 1;
    breaker.recordSuccess(100);
    now += 1;
    breaker.recordSuccess(900);

    expect(breaker.state).toBe("OPEN");
  });

  it("evicts samples outside the sliding window", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({
      minimumRequests: 3,
      windowSizeMs: 1_000,
      now: () => now,
    });

    breaker.recordFailure(10);
    now = 2_500;
    breaker.recordSuccess(10);
    breaker.recordSuccess(10);
    breaker.recordSuccess(10);

    expect(breaker.state).toBe("CLOSED");
    expect(breaker.getSnapshot()).toMatchObject({
      requestCount: 3,
      failureCount: 0,
      errorRate: 0,
    });
  });

  it("returns 503 with Retry-After without touching downstream work when OPEN", async () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({
      minimumRequests: 3,
      cooldownMs: 10_000,
      now: () => now,
    });
    trip(breaker);

    const untouchedStore: IdempotencyStore = {
      reserve: () => {
        throw new Error("Downstream work must not run while the circuit is open");
      },
    };
    const worker = createWorker(
      untouchedStore,
      breaker,
      new TelemetryTracer({ sink: () => {} }),
    );
    const response = await worker.fetch(
      postRequest(validBody("blocked")),
      {},
      context,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("10");
    await expect(response.json()).resolves.toMatchObject({
      code: "CIRCUIT_OPEN",
      state: "OPEN",
      retryAfterSeconds: 10,
    });
  });

  it("moves from OPEN to HALF_OPEN after cooldown and back to CLOSED on success", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({
      minimumRequests: 3,
      cooldownMs: 10_000,
      now: () => now,
    });
    trip(breaker);

    now += 9_999;
    expect(breaker.state).toBe("OPEN");

    now += 1;
    expect(breaker.state).toBe("HALF_OPEN");
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.allowRequest()).toBe(false);

    breaker.recordSuccess(25);
    expect(breaker.state).toBe("CLOSED");
    expect(breaker.getSnapshot()).toMatchObject({
      state: "CLOSED",
      requestCount: 0,
      errorRate: 0,
    });
  });

  it("allows the Worker to recover through HALF_OPEN after cooldown", async () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({
      minimumRequests: 3,
      cooldownMs: 10_000,
      now: () => now,
    });
    trip(breaker);

    const worker = createWorker(
      new InMemoryIdempotencyStore(),
      breaker,
      new TelemetryTracer({ sink: () => {} }),
    );
    const body = validBody("recovery");
    const blocked = await worker.fetch(postRequest(body), {}, context);
    expect(blocked.status).toBe(503);

    now += 10_000;
    const recovered = await worker.fetch(postRequest(body), {}, context);

    expect(recovered.status).toBe(200);
    expect(breaker.state).toBe("CLOSED");
  });

  it("reopens immediately when the HALF_OPEN probe fails", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({
      minimumRequests: 3,
      cooldownMs: 10_000,
      now: () => now,
    });
    trip(breaker);

    now += 10_000;
    expect(breaker.allowRequest()).toBe(true);
    breaker.recordFailure(25);

    expect(breaker.state).toBe("OPEN");
    expect(breaker.retryAfterSeconds).toBe(10);
  });
});
