import { describe, expect, it } from "vitest";
import { createWorker } from "../../src/index";
import { CircuitBreaker } from "../../src/middleware/circuit-breaker";
import { InMemoryIdempotencyStore } from "../../src/middleware/idempotency";
import { TelemetryTracer } from "../../src/middleware/telemetry";
import type {
  TelemetryLogEntry,
  TraceRecord,
} from "../../src/middleware/telemetry";

const context = {} as ExecutionContext;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function payloadFor(suffix: string) {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    amount: 125.5,
    currency: "AUD",
    customerEmail: `customer-${suffix}@example.com`,
    timestamp: "2026-10-20T01:20:00.000Z",
  };
}

function postRequest(body: string): Request {
  return new Request("https://rem.example/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function traceIdOf(response: Response): string {
  const traceId = response.headers.get("x-trace-id");
  if (!traceId) {
    throw new Error("Response is missing the x-trace-id header");
  }
  return traceId;
}

function getTraceOrThrow(
  tracer: TelemetryTracer,
  traceId: string,
): TraceRecord {
  const trace = tracer.getTrace(traceId);
  if (!trace) {
    throw new Error(`Trace ${traceId} was not recorded`);
  }
  return trace;
}

function setup() {
  const logs: TelemetryLogEntry[] = [];
  const tracer = new TelemetryTracer({
    sink: (entry) => logs.push(entry),
  });
  const worker = createWorker(
    new InMemoryIdempotencyStore(),
    new CircuitBreaker(),
    tracer,
  );

  return { logs, tracer, worker };
}

function trip(breaker: CircuitBreaker): void {
  breaker.recordFailure(10);
  breaker.recordFailure(10);
  breaker.recordFailure(10);
}

describe("TelemetryTracer", () => {
  it("assigns a unique UUID trace ID and propagates it", async () => {
    const { logs, tracer, worker } = setup();
    const first = await worker.fetch(
      postRequest(JSON.stringify(payloadFor("trace-one"))),
      {},
      context,
    );
    const second = await worker.fetch(
      postRequest(JSON.stringify(payloadFor("trace-two"))),
      {},
      context,
    );

    const firstTraceId = traceIdOf(first);
    const secondTraceId = traceIdOf(second);

    expect(firstTraceId).toMatch(UUID_PATTERN);
    expect(secondTraceId).toMatch(UUID_PATTERN);
    expect(firstTraceId).not.toBe(secondTraceId);
    expect(tracer.getTrace(firstTraceId)?.trace_id).toBe(firstTraceId);
    expect(logs.some((log) => log.trace_id === firstTraceId)).toBe(true);
    expect(logs.some((log) => log.trace_id === secondTraceId)).toBe(true);
  });

  it("records all five phases on a successful request", async () => {
    const { logs, tracer, worker } = setup();
    const response = await worker.fetch(
      postRequest(JSON.stringify(payloadFor("success"))),
      {},
      context,
    );
    const trace = getTraceOrThrow(tracer, traceIdOf(response));

    expect(response.status).toBe(200);
    expect(trace.spans.map((span) => span.name)).toEqual([
      "request_ingress",
      "circuit_breaker_check",
      "idempotency_check",
      "schema_validation",
      "handler_execution",
    ]);
    expect(trace.spans.every((span) => span.trace_id === trace.trace_id)).toBe(
      true,
    );
    expect(trace.spans.every((span) => span.durationMs >= 0)).toBe(true);
    expect(trace.logs).toHaveLength(5);
    expect(trace.logs.at(-1)).toMatchObject({
      span: "request_ingress",
      statusCode: 200,
      message: "request completed",
    });
    expect(logs.some((log) => log.statusCode === 200)).toBe(true);
    for (const log of trace.logs) {
      expect(log.trace_id).toBe(trace.trace_id);
      expect(log.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(log.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("records a validation failure without a handler span", async () => {
    const { tracer, worker } = setup();
    const response = await worker.fetch(
      postRequest(
        JSON.stringify({
          ...payloadFor("invalid"),
          amount: -1,
        }),
      ),
      {},
      context,
    );
    const trace = getTraceOrThrow(tracer, traceIdOf(response));
    const validationSpan = trace.spans.find(
      (span) => span.name === "schema_validation",
    );

    expect(response.status).toBe(400);
    expect(trace.spans.map((span) => span.name)).toEqual([
      "request_ingress",
      "circuit_breaker_check",
      "idempotency_check",
      "schema_validation",
    ]);
    expect(validationSpan).toMatchObject({
      statusCode: 400,
      status: "ERROR",
    });
    expect(trace.logs.at(-1)).toMatchObject({
      span: "request_ingress",
      statusCode: 400,
      level: "warn",
    });
  });

  it("records a duplicate rejection with a 409 idempotency span", async () => {
    const { tracer, worker } = setup();
    const body = JSON.stringify(payloadFor("duplicate"));

    const first = await worker.fetch(postRequest(body), {}, context);
    const second = await worker.fetch(postRequest(body), {}, context);
    const trace = getTraceOrThrow(tracer, traceIdOf(second));
    const idempotencySpan = trace.spans.find(
      (span) => span.name === "idempotency_check",
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(trace.spans.map((span) => span.name)).toEqual([
      "request_ingress",
      "circuit_breaker_check",
      "idempotency_check",
    ]);
    expect(idempotencySpan).toMatchObject({
      statusCode: 409,
      status: "ERROR",
    });
    expect(trace.logs.at(-1)).toMatchObject({
      span: "request_ingress",
      statusCode: 409,
      level: "warn",
    });
  });

  it("records a circuit-breaker rejection with a 503 ingress log", async () => {
    const breaker = new CircuitBreaker({
      minimumRequests: 3,
      cooldownMs: 10_000,
    });
    trip(breaker);

    const logs: TelemetryLogEntry[] = [];
    const tracer = new TelemetryTracer({
      sink: (entry) => logs.push(entry),
    });
    const worker = createWorker(
      new InMemoryIdempotencyStore(),
      breaker,
      tracer,
    );

    const response = await worker.fetch(
      postRequest(JSON.stringify(payloadFor("blocked"))),
      {},
      context,
    );
    const trace = getTraceOrThrow(tracer, traceIdOf(response));
    const breakerSpan = trace.spans.find(
      (span) => span.name === "circuit_breaker_check",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(trace.spans.map((span) => span.name)).toEqual([
      "request_ingress",
      "circuit_breaker_check",
    ]);
    expect(breakerSpan).toMatchObject({
      statusCode: 503,
      status: "ERROR",
    });
    expect(trace.logs.at(-1)).toMatchObject({
      span: "request_ingress",
      statusCode: 503,
      level: "error",
    });
    expect(logs.some((log) => log.trace_id === trace.trace_id)).toBe(true);
  });
});
