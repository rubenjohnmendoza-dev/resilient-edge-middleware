import { describe, expect, it } from "vitest";
import { createWorker } from "../../src/index";
import { CircuitBreaker } from "../../src/middleware/circuit-breaker";
import { InMemoryIdempotencyStore } from "../../src/middleware/idempotency";
import { TelemetryTracer } from "../../src/middleware/telemetry";

const validPayload = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  amount: 125.5,
  currency: "AUD",
  customerEmail: "customer@example.com",
  timestamp: "2026-10-20T01:20:00.000Z",
};

function request(body: string, method = "POST"): Request {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
  };

  if (method !== "GET") {
    init.body = body;
  }

  return new Request("https://rem.example/orders", init);
}

const context = {} as ExecutionContext;

function createTestWorker() {
  return createWorker(
    new InMemoryIdempotencyStore(),
    new CircuitBreaker(),
    new TelemetryTracer({ sink: () => {} }),
  );
}

describe("order payload handler", () => {
  it("accepts a valid order", async () => {
    const response = await createTestWorker().fetch(
      request(JSON.stringify(validPayload)),
      {},
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: validPayload,
    });
  });

  it("rejects unknown fields with structured issues", async () => {
    const response = await createTestWorker().fetch(
      request(JSON.stringify({ ...validPayload, injected: true })),
      {},
      context,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      issues: Array<{ path: string; code: string }>;
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "(root)", code: "unrecognized_keys" }),
      ]),
    );
  });

  it("rejects malformed JSON", async () => {
    const response = await createTestWorker().fetch(
      request("{nope"),
      {},
      context,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_JSON",
    });
  });

  it("rejects non-POST methods", async () => {
    const response = await createTestWorker().fetch(
      request("", "GET"),
      {},
      context,
    );

    expect(response.status).toBe(405);
  });
});
