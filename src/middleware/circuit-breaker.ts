export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureRateThreshold?: number;
  minimumRequests?: number;
  windowSizeMs?: number;
  latencyThresholdMs?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface CircuitSnapshot {
  state: CircuitState;
  requestCount: number;
  failureCount: number;
  errorRate: number;
  averageLatencyMs: number;
  retryAfterSeconds: number;
}

interface RequestSample {
  timestamp: number;
  latencyMs: number;
  failed: boolean;
}

export class CircuitOpenError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Circuit breaker is open");
    this.name = "CircuitOpenError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Sliding-window circuit breaker.
 *
 * Defaults: 30% failure rate, 3 samples, 30-second window, 1000 ms latency
 * threshold, and a 10-second cooldown. State transitions are evaluated lazily
 * on the next request or state read, so the breaker works without timers.
 *
 * The instance is isolate-local. Use a Durable Object or another shared store
 * when circuit state must be coordinated across Worker isolates.
 */
export class CircuitBreaker {
  private currentState: CircuitState = "CLOSED";
  private readonly failureRateThreshold: number;
  private readonly minimumRequests: number;
  private readonly windowSizeMs: number;
  private readonly latencyThresholdMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private samples: RequestSample[] = [];
  private openedAt = 0;
  private halfOpenInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureRateThreshold = options.failureRateThreshold ?? 0.3;
    this.minimumRequests = options.minimumRequests ?? 3;
    this.windowSizeMs = options.windowSizeMs ?? 30_000;
    this.latencyThresholdMs = options.latencyThresholdMs ?? 1_000;
    this.cooldownMs = options.cooldownMs ?? 10_000;
    this.now = options.now ?? (() => Date.now());

    if (!(this.failureRateThreshold > 0 && this.failureRateThreshold <= 1)) {
      throw new RangeError(
        "failureRateThreshold must be greater than 0 and at most 1",
      );
    }
    if (!Number.isInteger(this.minimumRequests) || this.minimumRequests < 1) {
      throw new RangeError("minimumRequests must be a positive integer");
    }
    if (!Number.isFinite(this.windowSizeMs) || this.windowSizeMs <= 0) {
      throw new RangeError("windowSizeMs must be greater than 0");
    }
    if (
      !Number.isFinite(this.latencyThresholdMs) ||
      this.latencyThresholdMs <= 0
    ) {
      throw new RangeError("latencyThresholdMs must be greater than 0");
    }
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < 0) {
      throw new RangeError("cooldownMs must be zero or greater");
    }
  }

  get state(): CircuitState {
    this.refreshState();
    return this.currentState;
  }

  get retryAfterSeconds(): number {
    this.refreshState();

    if (this.currentState === "CLOSED") {
      return 0;
    }
    if (this.currentState === "HALF_OPEN") {
      return 1;
    }

    return Math.max(
      1,
      Math.ceil((this.openedAt + this.cooldownMs - this.now()) / 1_000),
    );
  }

  getState(): CircuitState {
    return this.state;
  }

  getRetryAfterSeconds(): number {
    return this.retryAfterSeconds;
  }

  /**
   * Admits a request when possible. In HALF_OPEN, only one probe request is
   * admitted at a time so concurrent traffic cannot bypass the recovery test.
   */
  allowRequest(): boolean {
    this.refreshState();

    if (this.currentState === "OPEN") {
      return false;
    }

    if (this.currentState === "HALF_OPEN") {
      if (this.halfOpenInFlight) {
        return false;
      }
      this.halfOpenInFlight = true;
    }

    return true;
  }

  recordSuccess(latencyMs = 0): void {
    this.refreshState();

    if (this.currentState === "HALF_OPEN") {
      this.close();
      return;
    }
    if (this.currentState !== "CLOSED") {
      return;
    }

    this.addSample(latencyMs, false);
    this.evaluate();
  }

  recordFailure(latencyMs = 0): void {
    this.refreshState();

    if (this.currentState === "HALF_OPEN") {
      this.trip();
      return;
    }
    if (this.currentState !== "CLOSED") {
      return;
    }

    this.addSample(latencyMs, true);
    this.evaluate();
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.allowRequest()) {
      throw new CircuitOpenError(this.retryAfterSeconds);
    }

    const startedAt = this.now();

    try {
      const result = await operation();
      this.recordSuccess(Math.max(0, this.now() - startedAt));
      return result;
    } catch (error) {
      this.recordFailure(Math.max(0, this.now() - startedAt));
      throw error;
    }
  }

  getSnapshot(): CircuitSnapshot {
    const now = this.now();
    this.refreshState();
    this.prune(now);

    const requestCount = this.samples.length;
    const failureCount = this.samples.reduce(
      (count, sample) => count + (sample.failed ? 1 : 0),
      0,
    );
    const totalLatencyMs = this.samples.reduce(
      (total, sample) => total + sample.latencyMs,
      0,
    );

    return {
      state: this.currentState,
      requestCount,
      failureCount,
      errorRate: requestCount === 0 ? 0 : failureCount / requestCount,
      averageLatencyMs:
        requestCount === 0 ? 0 : totalLatencyMs / requestCount,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }

  reset(): void {
    this.close();
  }

  private refreshState(): void {
    if (
      this.currentState === "OPEN" &&
      this.now() >= this.openedAt + this.cooldownMs
    ) {
      this.currentState = "HALF_OPEN";
      this.halfOpenInFlight = false;
    }
  }

  private addSample(latencyMs: number, failed: boolean): void {
    const timestamp = this.now();
    const safeLatencyMs =
      Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0;

    this.samples.push({
      timestamp,
      latencyMs: safeLatencyMs,
      failed,
    });
    this.prune(timestamp);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowSizeMs;
    this.samples = this.samples.filter(
      (sample) => sample.timestamp >= cutoff,
    );
  }

  private evaluate(): void {
    this.prune(this.now());

    if (this.samples.length < this.minimumRequests) {
      return;
    }

    const failureCount = this.samples.reduce(
      (count, sample) => count + (sample.failed ? 1 : 0),
      0,
    );
    const errorRate = failureCount / this.samples.length;
    const latencySpike = this.samples.some(
      (sample) => sample.latencyMs > this.latencyThresholdMs,
    );

    if (errorRate > this.failureRateThreshold || latencySpike) {
      this.trip();
    }
  }

  private trip(): void {
    this.currentState = "OPEN";
    this.openedAt = this.now();
    this.halfOpenInFlight = false;
  }

  private close(): void {
    this.currentState = "CLOSED";
    this.halfOpenInFlight = false;
    this.openedAt = 0;
    this.samples = [];
  }
}
