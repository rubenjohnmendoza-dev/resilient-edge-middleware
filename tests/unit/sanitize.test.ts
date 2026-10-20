import { describe, expect, it } from "vitest";
import { createWorker } from "../../src/index";
import { CircuitBreaker } from "../../src/middleware/circuit-breaker";
import { InMemoryIdempotencyStore } from "../../src/middleware/idempotency";
import { sanitizePayload } from "../../src/middleware/sanitize";
import { TelemetryTracer } from "../../src/middleware/telemetry";

const context = {} as ExecutionContext;

function postRequest(body: string): Request {
  return new Request("https://rem.example/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function createTestWorker() {
  return createWorker(
    new InMemoryIdempotencyStore(),
    new CircuitBreaker(),
    new TelemetryTracer({ sink: () => {} }),
  );
}

describe("sanitizePayload", () => {
  it("strips zero-width, bidi, and tag characters recursively", () => {
    const poisoned = {
      "na\u200Bme": "  Ali\u202Ece  ",
      nested: ["he\u200Cllo", { value: "tag\u{E0041}\u{E007F}" }],
      "bid\u2066i": "\u202Eabc\u2069",
    };

    expect(sanitizePayload(poisoned)).toEqual({
      name: "Alice",
      nested: ["hello", { value: "tag" }],
      bidi: "abc",
    });
  });

  it("normalizes Unicode and trims leading and trailing whitespace", () => {
    const payload = {
      text: "  cafe\u0301  ",
      multiline: "  line one\nline two  ",
    };

    expect(sanitizePayload(payload)).toEqual({
      text: "café",
      multiline: "line one\nline two",
    });
  });

  it("leaves clean payloads unchanged and does not mutate the input", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      amount: 125.5,
      currency: "AUD",
      customerEmail: "customer@example.com",
      timestamp: "2026-10-20T01:20:00.000Z",
      tags: ["clean", 42, true, null],
    };
    const original = structuredClone(payload);

    expect(sanitizePayload(payload)).toStrictEqual(payload);
    expect(payload).toStrictEqual(original);
  });
});

describe("Worker sanitization integration", () => {
  it("sanitizes poisoned fields before Zod validation", async () => {
    const response = await createTestWorker().fetch(
      postRequest(
        JSON.stringify({
          id: "550e8400-e29b-41d4-a716-446655440000\u200B",
          amount: 19.99,
          currency: "A\u200BUD",
          customerEmail: "customer@example.com\u202E",
          timestamp: "2026-10-20T01:20:00.000Z\u2066",
        }),
      ),
      {},
      context,
    );
    const body = (await response.json()) as {
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      id: "550e8400-e29b-41d4-a716-446655440000",
      amount: 19.99,
      currency: "AUD",
      customerEmail: "customer@example.com",
      timestamp: "2026-10-20T01:20:00.000Z",
    });
  });

  it("still rejects genuinely invalid data after sanitization", async () => {
    const response = await createTestWorker().fetch(
      postRequest(
        JSON.stringify({
          id: "550e8400-e29b-41d4-a716-446655440000",
          amount: -1,
          currency: "AUD",
          customerEmail: "customer@example.com",
          timestamp: "2026-10-20T01:20:00.000Z",
        }),
      ),
      {},
      context,
    );
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});
