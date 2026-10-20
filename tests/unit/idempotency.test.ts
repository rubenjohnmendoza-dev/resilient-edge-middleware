import { describe, expect, it } from "vitest";
import { createWorker } from "../../src/index";
import { CircuitBreaker } from "../../src/middleware/circuit-breaker";
import {
  checkIdempotency,
  InMemoryIdempotencyStore,
} from "../../src/middleware/idempotency";
import { TelemetryTracer } from "../../src/middleware/telemetry";

const context = {} as ExecutionContext;

function postRequest(body: string): Request {
  return new Request("https://rem.example/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function payloadFor(suffix: string) {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    amount: 125.5,
    currency: "AUD",
    customerEmail: `customer-${suffix}@example.com`,
    timestamp: "2026-10-20T01:20:00.000Z",
  };
}

describe("checkIdempotency", () => {
  it("computes the SHA-256 hash of the request body", async () => {
    const body = "abc";
    const result = await checkIdempotency(
      postRequest(body),
      body,
      new InMemoryIdempotencyStore(),
    );

    expect(result.hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(result.isDuplicate).toBe(false);
  });

  it("rejects a repeated payload", async () => {
    const store = new InMemoryIdempotencyStore();
    const body = JSON.stringify(payloadFor("repeat"));
    const first = await checkIdempotency(postRequest(body), body, store);
    const second = await checkIdempotency(postRequest(body), body, store);

    expect(first.isDuplicate).toBe(false);
    expect(second).toEqual({ isDuplicate: true, hash: first.hash });
  });

  it("allows only one of two concurrent identical requests", async () => {
    const store = new InMemoryIdempotencyStore();
    const body = JSON.stringify(payloadFor("concurrent"));

    const [first, second] = await Promise.all([
      checkIdempotency(postRequest(body), body, store),
      checkIdempotency(postRequest(body), body, store),
    ]);

    expect([first.isDuplicate, second.isDuplicate].filter(Boolean)).toHaveLength(
      1,
    );
    expect(first.hash).toBe(second.hash);
  });

  it("allows the payload again after the TTL expires", async () => {
    let now = 1_000;
    const store = new InMemoryIdempotencyStore(1_000, () => now);
    const body = JSON.stringify(payloadFor("ttl"));

    const first = await checkIdempotency(postRequest(body), body, store);
    now = 1_999;
    const beforeExpiry = await checkIdempotency(
      postRequest(body),
      body,
      store,
    );
    now = 2_000;
    const afterExpiry = await checkIdempotency(
      postRequest(body),
      body,
      store,
    );

    expect(first.isDuplicate).toBe(false);
    expect(beforeExpiry.isDuplicate).toBe(true);
    expect(afterExpiry.isDuplicate).toBe(false);
  });

  it("treats different bodies as distinct requests", async () => {
    const store = new InMemoryIdempotencyStore();
    const firstBody = JSON.stringify(payloadFor("first"));
    const secondBody = JSON.stringify(payloadFor("second"));

    const first = await checkIdempotency(postRequest(firstBody), firstBody, store);
    const second = await checkIdempotency(
      postRequest(secondBody),
      secondBody,
      store,
    );

    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(false);
    expect(second.hash).not.toBe(first.hash);
  });
});

describe("idempotent Worker requests", () => {
  it("returns 409 Conflict for a duplicate POST", async () => {
    const worker = createWorker(
      new InMemoryIdempotencyStore(),
      new CircuitBreaker(),
      new TelemetryTracer({ sink: () => {} }),
    );
    const body = JSON.stringify(payloadFor("worker"));

    const first = await worker.fetch(postRequest(body), {}, context);
    const second = await worker.fetch(postRequest(body), {}, context);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);

    const responseBody = (await second.json()) as {
      code: string;
      isDuplicate: boolean;
      hash: string;
    };
    expect(responseBody.code).toBe("DUPLICATE_REQUEST");
    expect(responseBody.isDuplicate).toBe(true);
    expect(responseBody.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("checks idempotency before schema validation", async () => {
    const worker = createWorker(
      new InMemoryIdempotencyStore(),
      new CircuitBreaker(),
      new TelemetryTracer({ sink: () => {} }),
    );
    const body = JSON.stringify({
      ...payloadFor("invalid"),
      amount: -1,
    });

    const first = await worker.fetch(postRequest(body), {}, context);
    const second = await worker.fetch(postRequest(body), {}, context);

    expect(first.status).toBe(400);
    expect(second.status).toBe(409);
  });
});
