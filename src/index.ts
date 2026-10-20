import {
  checkIdempotency,
  InMemoryIdempotencyStore,
  type IdempotencyStore,
} from "./middleware/idempotency";
import { CircuitBreaker } from "./middleware/circuit-breaker";
import {
  TelemetryTracer,
  type TraceSession,
} from "./middleware/telemetry";
import { sanitizePayload } from "./middleware/sanitize";
import { OrderPayloadSchema } from "./validators/payload.schema";

interface Env {
  CHAOS_MODE?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
} as const;

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

const defaultIdempotencyStore = new InMemoryIdempotencyStore();
const defaultCircuitBreaker = new CircuitBreaker();
const defaultTelemetryTracer = new TelemetryTracer();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function processOrder(
  request: Request,
  idempotencyStore: IdempotencyStore,
  trace: TraceSession,
): Promise<Response> {
  const idempotencySpan = trace.startSpan("idempotency_check");
  let bodyText: string;

  try {
    bodyText = await request.text();
  } catch (error) {
    trace.endSpan(idempotencySpan, {
      statusCode: 400,
      message: "request body read failed",
      attributes: { error: errorMessage(error) },
    });
    return jsonResponse(
      { error: "Unable to read request body", code: "INVALID_BODY" },
      400,
    );
  }

  let idempotencyResult: { isDuplicate: boolean; hash: string };
  try {
    idempotencyResult = await checkIdempotency(
      request,
      bodyText,
      idempotencyStore,
    );
  } catch (error) {
    trace.endSpan(idempotencySpan, {
      statusCode: 500,
      message: "idempotency check failed",
      attributes: { error: errorMessage(error) },
    });
    throw error;
  }

  if (idempotencyResult.isDuplicate) {
    trace.endSpan(idempotencySpan, {
      statusCode: 409,
      message: "duplicate request rejected",
      attributes: {
        duplicate: true,
        hash: idempotencyResult.hash,
      },
    });
    return jsonResponse(
      {
        error: "Duplicate request",
        code: "DUPLICATE_REQUEST",
        isDuplicate: true,
        hash: idempotencyResult.hash,
      },
      409,
    );
  }

  trace.endSpan(idempotencySpan, {
    statusCode: 200,
    message: "idempotency check passed",
    attributes: {
      duplicate: false,
      hash: idempotencyResult.hash,
    },
  });

  const validationSpan = trace.startSpan("schema_validation");
  let payload: unknown;

  try {
    payload = JSON.parse(bodyText);
  } catch (error) {
    trace.endSpan(validationSpan, {
      statusCode: 400,
      message: "JSON parsing failed",
      attributes: { error: errorMessage(error) },
    });
    return jsonResponse(
      { error: "Request body must be valid JSON", code: "INVALID_JSON" },
      400,
    );
  }

  const result = OrderPayloadSchema.safeParse(sanitizePayload(payload));

  if (!result.success) {
    trace.endSpan(validationSpan, {
      statusCode: 400,
      message: "schema validation failed",
      attributes: { issueCount: result.error.issues.length },
    });
    return jsonResponse(
      {
        error: "Payload validation failed",
        code: "VALIDATION_ERROR",
        issues: result.error.issues.map((issue) => ({
          path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
          message: issue.message,
          code: issue.code,
        })),
      },
      400,
    );
  }

  trace.endSpan(validationSpan, {
    statusCode: 200,
    message: "schema validation passed",
  });

  const handlerSpan = trace.startSpan("handler_execution");
  try {
    const response = jsonResponse({ success: true, data: result.data }, 200);
    trace.endSpan(handlerSpan, {
      statusCode: response.status,
      message: "handler execution completed",
    });
    return response;
  } catch (error) {
    trace.endSpan(handlerSpan, {
      statusCode: 500,
      message: "handler execution failed",
      attributes: { error: errorMessage(error) },
    });
    throw error;
  }
}

async function handleRequest(
  request: Request,
  idempotencyStore: IdempotencyStore,
  circuitBreaker: CircuitBreaker,
  trace: TraceSession,
  chaosMode: boolean,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (request.method === "GET" && pathname === "/health") {
    return trace.finish(jsonResponse({ status: "ok" }, 200));
  }

  if (chaosMode && request.method === "POST" && pathname === "/_chaos/reset") {
    await idempotencyStore.clear?.();
    circuitBreaker.reset();
    return trace.finish(jsonResponse({ reset: true }, 200));
  }

  if (pathname.startsWith("/_chaos/")) {
    return trace.finish(
      jsonResponse({ error: "Not found", code: "NOT_FOUND" }, 404),
    );
  }

  if (request.method !== "POST") {
    return trace.finish(
      jsonResponse(
        { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" },
        405,
      ),
    );
  }

  const breakerSpan = trace.startSpan("circuit_breaker_check");
  let allowed: boolean;

  try {
    allowed = circuitBreaker.allowRequest();
  } catch (error) {
    trace.endSpan(breakerSpan, {
      statusCode: 500,
      message: "circuit breaker check failed",
      attributes: { error: errorMessage(error) },
    });
    throw error;
  }

  const retryAfterSeconds = allowed ? 0 : circuitBreaker.retryAfterSeconds;
  trace.endSpan(breakerSpan, {
    statusCode: allowed ? 200 : 503,
    message: allowed
      ? "circuit breaker admitted request"
      : "circuit breaker rejected request",
    attributes: {
      allowed,
      state: circuitBreaker.state,
      retryAfterSeconds,
    },
  });

  if (!allowed) {
    return trace.finish(
      jsonResponse(
        {
          error: "Service unavailable",
          code: "CIRCUIT_OPEN",
          state: circuitBreaker.state,
          retryAfterSeconds,
        },
        503,
        { "retry-after": String(retryAfterSeconds) },
      ),
    );
  }

  const startedAt = Date.now();

  if (chaosMode && request.headers.get("x-chaos-fail") === "1") {
    const handlerSpan = trace.startSpan("handler_execution");
    trace.endSpan(handlerSpan, {
      statusCode: 503,
      message: "chaos failure injected",
    });
    circuitBreaker.recordFailure(Math.max(0, Date.now() - startedAt));

    return trace.finish(
      jsonResponse(
        {
          error: "Simulated downstream failure",
          code: "CHAOS_FAILURE",
        },
        503,
      ),
    );
  }

  try {
    const response = await processOrder(request, idempotencyStore, trace);
    const latencyMs = Math.max(0, Date.now() - startedAt);

    if (response.status >= 500) {
      circuitBreaker.recordFailure(latencyMs);
    } else {
      circuitBreaker.recordSuccess(latencyMs);
    }

    return trace.finish(response);
  } catch (error) {
    circuitBreaker.recordFailure(Math.max(0, Date.now() - startedAt));
    throw error;
  }
}

export function createWorker(
  idempotencyStore: IdempotencyStore = defaultIdempotencyStore,
  circuitBreaker: CircuitBreaker = defaultCircuitBreaker,
  telemetryTracer: TelemetryTracer = defaultTelemetryTracer,
) {
  return {
    async fetch(
      request: Request,
      _env: Env,
      _ctx: ExecutionContext,
    ): Promise<Response> {
      const trace = telemetryTracer.startTrace(request);

      try {
        return await handleRequest(
          request,
          idempotencyStore,
          circuitBreaker,
          trace,
          _env.CHAOS_MODE === "true",
        );
      } catch (error) {
        const response = jsonResponse(
          { error: "Internal server error", code: "INTERNAL_ERROR" },
          500,
        );

        return trace.finish(response, { error: errorMessage(error) });
      }
    },
  };
}

export default createWorker();
