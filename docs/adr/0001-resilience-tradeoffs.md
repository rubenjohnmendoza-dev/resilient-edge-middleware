# ADR 0001: Resilience and Persistence Trade-offs

- **Status:** Accepted
- **Date:** 2026-10-21
- **Context:** REM must remain usable at the edge while protecting order intake
  from duplicate processing, transient failures, and unavailable persistence.

## Decision

REM combines three resilience mechanisms:

1. A PocketBase-backed idempotency store with an in-memory fallback.
2. An isolate-local sliding-window circuit breaker.
3. Explicit telemetry and audit records written through the storage adapter.

### In-memory Idempotency Fallback

PocketBase is the primary idempotency store. A request body hash is reserved for
24 hours using the collection's unique hash index. If PocketBase is unavailable,
the adapter falls back to an isolate-local memory reservation so local
development and short-lived edge instances can continue operating.

The fallback favors availability over global duplicate protection. During a
PocketBase outage, two different isolates may accept the same payload because
their memory maps are independent.

### Isolate-local Circuit Breaker

The circuit breaker tracks failures and latency in a sliding window and moves
through `CLOSED`, `OPEN`, and `HALF_OPEN`. It uses a 30% error threshold, a
minimum sample count, a latency threshold, a 10-second cooldown, and one
half-open probe.

The breaker intentionally remains isolate-local. This keeps the hot path fast
and avoids making every edge request depend on a centralized state service.
The trade-off is that one isolate can trip while another remains closed.

### PocketBase Persistence

PocketBase stores idempotency keys, request audit logs, and telemetry metrics.
The adapter authenticates as a superuser, creates the collections lazily, and
uses `waitUntil` to flush pending telemetry writes after the response.

PocketBase introduces a network dependency and operational setup requirements.
The in-memory fallback and console telemetry preserve a usable local path when
the service is unavailable, but they do not provide the same durability or
cross-instance guarantees.

## Consequences

- Local and single-isolate behavior remains available during PocketBase outages.
- Global idempotency and circuit state are not guaranteed during an outage.
- Production deployments should use a Durable Object, SQLite, or another
  atomic shared store when cross-isolate guarantees are required.
- The Docker/PocketBase runtime remains a local operational dependency; the
  Compose definition is validated but full runtime execution requires Docker.

## Alternatives Considered

- **Memory-only idempotency:** rejected because data is lost on isolate restart.
- **PocketBase-only idempotency:** rejected because a backend outage would make
  the local development path unusable.
- **Global breaker in PocketBase:** rejected for the hot path because it adds
  latency and couples availability controls to the persistence service.
- **Durable Object breaker:** deferred until cross-isolate coordination is a
  production requirement.
