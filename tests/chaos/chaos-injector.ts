export {};

type JsonObject = Record<string, unknown>;

interface OrderPayload {
  id: string;
  amount: number;
  currency: "USD" | "PHP" | "AUD";
  customerEmail: string;
  timestamp: string;
}

const REM_URL = (process.env.REM_URL ?? "http://127.0.0.1:8787").replace(
  /\/$/,
  "",
);
const WEBHOOK_URL = (
  process.env.WEBHOOK_URL ?? "http://127.0.0.1:8788"
).replace(/\/$/, "");
const SEED = positiveInteger(process.env.CHAOS_SEED, 20_261_020);
const SPIKE_REQUESTS = positiveInteger(
  process.env.CHAOS_SPIKE_REQUESTS,
  60,
);
const BURSTS = positiveInteger(process.env.CHAOS_BURSTS, 3);
const REQUEST_TIMEOUT_MS = 10_000;

const random = createRandom(SEED);

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function logEvent(event: string, details: JsonObject = {}): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...details,
    }),
  );
}

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<JsonObject> {
  try {
    const value: unknown = await response.json();
    return isJsonObject(value) ? value : {};
  } catch {
    return {};
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function requestWithTimeout(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function postOrder(
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return requestWithTimeout(`${REM_URL}/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

async function waitForService(
  name: string,
  healthUrl: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "service did not respond";

  while (Date.now() < deadline) {
    try {
      const response = await requestWithTimeout(healthUrl, { method: "GET" });
      if (response.ok) {
        logEvent("chaos.service.ready", { service: name });
        return;
      }
      lastError = `health check returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(500);
  }

  throw new Error(`${name} did not become ready: ${lastError}`);
}

async function resetState(label: string): Promise<void> {
  const response = await requestWithTimeout(`${REM_URL}/_chaos/reset`, {
    method: "POST",
  });
  assert(
    response.status === 200,
    `Reset failed with ${response.status}; is CHAOS_MODE enabled?`,
  );
  logEvent("chaos.reset", { label });
}

function validPayload(suffix: string): OrderPayload {
  const currencies = ["USD", "PHP", "AUD"] as const;
  const currency = currencies[Math.floor(random() * currencies.length)] ?? "AUD";

  return {
    id: crypto.randomUUID(),
    amount: Math.round((1 + random() * 1_000) * 100) / 100,
    currency,
    customerEmail: `customer-${suffix}@example.com`,
    timestamp: new Date().toISOString(),
  };
}

function malformedBody(index: number): string {
  const base = validPayload(`malformed-${index}-${crypto.randomUUID()}`);

  switch (Math.floor(random() * 6)) {
    case 0:
      return `{"id":${index}`;
    case 1:
      return JSON.stringify({ ...base, amount: -1 });
    case 2:
      return JSON.stringify({ ...base, currency: "EUR" });
    case 3:
      return JSON.stringify({ ...base, customerEmail: "not-an-email" });
    case 4:
      return JSON.stringify({ ...base, unexpected: crypto.randomUUID() });
    default:
      return `not-json-${index}`;
  }
}

async function assertWebhookLink(): Promise<void> {
  const webhookBody = {
    event: "order.created",
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
  const response = await requestWithTimeout(`${WEBHOOK_URL}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(webhookBody),
  });
  const body = await readJson(response);

  assert(
    response.status === 202,
    `Mock webhook returned ${response.status}, expected 202`,
  );
  assert(body.received === true, "Mock webhook did not acknowledge receipt");
  logEvent("chaos.webhook.ok", { webhookId: webhookBody.id });
}

async function assertMalformedPayloads(): Promise<number> {
  let rejected = 0;

  for (let index = 0; index < 25; index += 1) {
    const response = await postOrder(malformedBody(index));
    const body = await readJson(response);

    assert(
      response.status === 400,
      `Malformed payload ${index} returned ${response.status}, expected 400`,
    );
    assert(
      body.code === "INVALID_JSON" || body.code === "VALIDATION_ERROR",
      `Malformed payload ${index} returned unexpected code: ${String(body.code)}`,
    );
    rejected += 1;
  }

  logEvent("chaos.malformed.ok", { rejected });
  return rejected;
}

async function assertDuplicateRejection(): Promise<void> {
  const body = JSON.stringify(validPayload(`duplicate-${crypto.randomUUID()}`));
  const first = await postOrder(body);
  const second = await postOrder(body);
  const secondBody = await readJson(second);

  assert(first.status === 200, `First duplicate probe returned ${first.status}`);
  assert(
    second.status === 409,
    `Second duplicate probe returned ${second.status}, expected 409`,
  );
  assert(
    secondBody.code === "DUPLICATE_REQUEST",
    `Duplicate probe returned unexpected code: ${String(secondBody.code)}`,
  );
  logEvent("chaos.idempotency.ok", { status: second.status });
}

async function assertTrafficSpikes(): Promise<{
  statuses: Record<string, number>;
  requests: number;
}> {
  const statuses: Record<string, number> = {};
  let requestCount = 0;

  for (let burst = 0; burst < BURSTS; burst += 1) {
    const duplicateBody = JSON.stringify(
      validPayload(`burst-${burst}-${crypto.randomUUID()}`),
    );
    const requests = Array.from({ length: SPIKE_REQUESTS }, (_, index) => {
      const selector = index % 5;

      if (selector === 0) {
        return postOrder(malformedBody(index));
      }
      if (selector === 1) {
        return postOrder(
          JSON.stringify({ ...validPayload(`schema-${burst}-${index}`), amount: -1 }),
        );
      }
      if (selector === 2) {
        return postOrder(duplicateBody);
      }

      return postOrder(
        JSON.stringify(validPayload(`spike-${burst}-${index}-${crypto.randomUUID()}`)),
      );
    });
    const responses = await Promise.all(requests);

    for (const response of responses) {
      requestCount += 1;
      const status = String(response.status);
      statuses[status] = (statuses[status] ?? 0) + 1;

      assert(
        ["200", "400", "409", "503"].includes(status),
        `Traffic spike produced unexpected status ${status}`,
      );

      const body = await readJson(response);
      assert(
        body.code !== "INTERNAL_ERROR",
        "Worker returned INTERNAL_ERROR during traffic spike",
      );
    }
  }

  const health = await requestWithTimeout(`${REM_URL}/health`);
  assert(health.status === 200, "Worker health check failed after traffic spike");

  logEvent("chaos.spike.ok", { statuses, requests: requestCount });
  return { statuses, requests: requestCount };
}

async function assertCircuitTrip(): Promise<void> {
  await resetState("before-circuit-test");

  let injectedFailures = 0;
  for (let index = 0; index < 3; index += 1) {
    const response = await postOrder(
      JSON.stringify(validPayload(`forced-failure-${crypto.randomUUID()}`)),
      { "x-chaos-fail": "1" },
    );
    const body = await readJson(response);

    assert(
      response.status === 503,
      `Chaos failure ${index} returned ${response.status}, expected 503`,
    );
    assert(
      body.code === "CHAOS_FAILURE" || body.code === "CIRCUIT_OPEN",
      `Chaos failure ${index} returned unexpected code: ${String(body.code)}`,
    );
    injectedFailures += 1;
  }

  const blocked = await postOrder(
    JSON.stringify(validPayload(`blocked-${crypto.randomUUID()}`)),
  );
  const blockedBody = await readJson(blocked);
  const retryAfter = blocked.headers.get("retry-after");

  assert(
    blocked.status === 503,
    `Expected circuit breaker 503 after failures, got ${blocked.status}`,
  );
  assert(
    blockedBody.code === "CIRCUIT_OPEN",
    `Expected CIRCUIT_OPEN, got ${String(blockedBody.code)}`,
  );
  assert(
    retryAfter !== null && Number(retryAfter) > 0,
    "Circuit breaker response is missing a valid Retry-After header",
  );

  const health = await requestWithTimeout(`${REM_URL}/health`);
  assert(health.status === 200, "Worker health check failed while circuit is open");

  logEvent("chaos.circuit.ok", {
    injectedFailures,
    retryAfter,
    status: blocked.status,
  });
}

async function main(): Promise<void> {
  logEvent("chaos.start", {
    remUrl: REM_URL,
    webhookUrl: WEBHOOK_URL,
    seed: SEED,
    spikeRequests: SPIKE_REQUESTS,
    bursts: BURSTS,
  });

  await waitForService("rem", `${REM_URL}/health`);
  await waitForService("webhook-mock", `${WEBHOOK_URL}/health`);
  await resetState("initial");

  await assertWebhookLink();
  const malformedRejected = await assertMalformedPayloads();
  await assertDuplicateRejection();
  const spike = await assertTrafficSpikes();
  await assertCircuitTrip();
  await resetState("cleanup");

  logEvent("chaos.passed", {
    malformedRejected,
    duplicateRejected: true,
    circuitTripped: true,
    spikeRequests: spike.requests,
    spikeStatuses: spike.statuses,
  });
}

try {
  await main();
} catch (error) {
  logEvent("chaos.failed", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
