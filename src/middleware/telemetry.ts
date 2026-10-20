export type SpanName =
  | "request_ingress"
  | "circuit_breaker_check"
  | "idempotency_check"
  | "schema_validation"
  | "handler_execution";

export type SpanStatus = "OK" | "ERROR";
export type TelemetryLogLevel = "info" | "warn" | "error";

export interface SpanRecord {
  name: SpanName;
  trace_id: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: SpanStatus;
  statusCode?: number;
  message?: string;
  attributes: Record<string, unknown>;
}

export interface TelemetryLogEntry {
  timestamp: string;
  trace_id: string;
  span: SpanName;
  level: TelemetryLogLevel;
  message: string;
  statusCode: number;
  durationMs: number;
  attributes: Record<string, unknown>;
}

export interface TraceRecord {
  trace_id: string;
  startedAt: string;
  spans: SpanRecord[];
  logs: TelemetryLogEntry[];
}

export interface SpanHandle {
  readonly name: SpanName;
  readonly startedAtMs: number;
  readonly record: SpanRecord;
}

export interface EndSpanOptions {
  statusCode?: number;
  status?: SpanStatus;
  level?: TelemetryLogLevel;
  message?: string;
  attributes?: Record<string, unknown>;
}

export type TelemetrySink = (entry: TelemetryLogEntry) => void;

export interface TelemetryTracerOptions {
  sink?: TelemetrySink;
  maxTraces?: number;
}

const DEFAULT_MAX_TRACES = 1_000;

function defaultSink(entry: TelemetryLogEntry): void {
  console.log(JSON.stringify(entry));
}

function statusFor(statusCode: number): SpanStatus {
  return statusCode >= 400 ? "ERROR" : "OK";
}

function levelFor(statusCode: number): TelemetryLogLevel {
  if (statusCode >= 500) {
    return "error";
  }
  if (statusCode >= 400) {
    return "warn";
  }
  return "info";
}

export class TraceSession {
  readonly trace_id: string;
  readonly startedAt: string;
  readonly spans: SpanRecord[] = [];
  readonly logs: TelemetryLogEntry[] = [];

  private readonly sink: TelemetrySink;
  private readonly requestAttributes: Record<string, unknown>;
  private readonly ingress: SpanHandle;
  private finished = false;

  constructor(
    traceId: string,
    sink: TelemetrySink,
    requestAttributes: Record<string, unknown>,
  ) {
    this.trace_id = traceId;
    this.startedAt = new Date().toISOString();
    this.sink = sink;
    this.requestAttributes = { ...requestAttributes };
    this.ingress = this.startSpan("request_ingress");
  }

  startSpan(name: SpanName): SpanHandle {
    const startedAtMs = Date.now();
    const record: SpanRecord = {
      name,
      trace_id: this.trace_id,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: "",
      durationMs: 0,
      status: "OK",
      attributes: {},
    };
    this.spans.push(record);

    return { name, startedAtMs, record };
  }

  endSpan(handle: SpanHandle, options: EndSpanOptions = {}): SpanRecord {
    if (handle.record.endedAt !== "") {
      return handle.record;
    }

    const endedAtMs = Date.now();
    const statusCode = options.statusCode ?? 200;
    const status = options.status ?? statusFor(statusCode);
    const level = options.level ?? levelFor(statusCode);
    const message = options.message ?? `${handle.name} completed`;
    const attributes = { ...(options.attributes ?? {}) };

    handle.record.endedAt = new Date(endedAtMs).toISOString();
    handle.record.durationMs = Math.max(0, endedAtMs - handle.startedAtMs);
    handle.record.status = status;
    handle.record.statusCode = statusCode;
    handle.record.message = message;
    handle.record.attributes = attributes;

    const log: TelemetryLogEntry = {
      timestamp: handle.record.endedAt,
      trace_id: this.trace_id,
      span: handle.name,
      level,
      message,
      statusCode,
      durationMs: handle.record.durationMs,
      attributes,
    };
    this.logs.push(log);
    this.sink(log);

    return handle.record;
  }

  finish(
    response: Response,
    attributes: Record<string, unknown> = {},
  ): Response {
    if (!this.finished) {
      this.finished = true;
      const statusCode = response.status;
      this.endSpan(this.ingress, {
        statusCode,
        status: statusFor(statusCode),
        level: levelFor(statusCode),
        message: "request completed",
        attributes: { ...this.requestAttributes, ...attributes },
      });
    }

    const headers = new Headers(response.headers);
    headers.set("x-trace-id", this.trace_id);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  toRecord(): TraceRecord {
    return {
      trace_id: this.trace_id,
      startedAt: this.startedAt,
      spans: this.spans.map((span) => ({
        ...span,
        attributes: { ...span.attributes },
      })),
      logs: this.logs.map((log) => ({
        ...log,
        attributes: { ...log.attributes },
      })),
    };
  }
}

export class TelemetryTracer {
  private readonly traces = new Map<string, TraceSession>();
  private readonly sink: TelemetrySink;
  private readonly maxTraces: number;

  constructor(options: TelemetryTracerOptions = {}) {
    this.sink = options.sink ?? defaultSink;
    this.maxTraces = options.maxTraces ?? DEFAULT_MAX_TRACES;

    if (!Number.isInteger(this.maxTraces) || this.maxTraces < 1) {
      throw new RangeError("maxTraces must be a positive integer");
    }
  }

  startTrace(request: Request): TraceSession {
    const traceId = crypto.randomUUID();
    const url = new URL(request.url);
    const session = new TraceSession(traceId, this.sink, {
      method: request.method,
      path: url.pathname,
    });

    this.traces.set(traceId, session);
    this.evictOldTraces();

    return session;
  }

  getTrace(traceId: string): TraceRecord | undefined {
    return this.traces.get(traceId)?.toRecord();
  }

  getRecentTraces(): TraceRecord[] {
    return Array.from(this.traces.values(), (session) => session.toRecord());
  }

  private evictOldTraces(): void {
    while (this.traces.size > this.maxTraces) {
      const oldestTraceId = this.traces.keys().next().value;
      if (oldestTraceId === undefined) {
        return;
      }
      this.traces.delete(oldestTraceId);
    }
  }
}
