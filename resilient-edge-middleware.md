# Resilient Edge Middleware (REM)

## Overview

Resilient Edge Middleware is a Cloudflare Worker-based order intake service that
combines zero-trust payload validation, persistent idempotency, circuit-breaker
resilience, and structured request tracing. It was built as a production-style
edge middleware project and extended with a local Docker stack and a separate
Python service for media metadata hygiene.

The project demonstrates how request safety, availability controls, operational
telemetry, and data sanitization can be composed into one coherent service
without making the edge runtime responsible for native document processing.

## Architecture

```text
Client
  |
  v
Cloudflare Worker
  |-- Trace creation and x-trace-id propagation
  |-- Circuit breaker admission check
  |-- SHA-256 idempotency reservation
  |-- JSON parsing
  |-- Recursive Unicode sanitization
  |-- Strict Zod schema validation
  |-- Handler response
  |
  +--> PocketBase REST persistence
        |-- idempotency_keys
        |-- request_audit_logs
        |-- telemetry_metrics

Local automation
  |
  +--> Python FastAPI media scrubber
        |-- PNG / JPEG metadata removal
        |-- PDF metadata and attachment removal
        |-- CLI batch processing

Docker Compose
  |-- REM Worker             :8787
  |-- PocketBase            :8090
  |-- Stirling-PDF           :8080
  |-- Mock webhook           :8788
  +-- Chaos test runner      on-demand profile
```

The Worker handles request text and protocol behavior. Binary document
processing is deliberately isolated in the Python service so image and PDF
libraries do not run in the edge runtime.

## Tech Stack

- TypeScript
- Cloudflare Workers and Wrangler
- Zod
- Vitest
- pnpm
- PocketBase
- Docker Compose
- Stirling-PDF
- Python 3.12
- FastAPI and Uvicorn
- Pillow
- pikepdf

## Key Features

### SHA-256 Idempotency

Every order body is hashed with SHA-256 and reserved for a 24-hour window.
PocketBase provides persistent storage with a unique hash index; the adapter
also supports an isolate-local memory fallback when PocketBase is unavailable.
Duplicate requests return HTTP `409 DUPLICATE_REQUEST` without re-running the
order handler.

### Sliding-Window Circuit Breaker

The circuit breaker tracks failure rate and latency over a configurable sliding
window. It supports `CLOSED`, `OPEN`, and `HALF_OPEN` states with:

- 30% error-rate threshold
- Minimum sample protection
- Configurable latency threshold
- 10-second cooldown
- Single-probe half-open recovery
- HTTP `503` short-circuiting with `Retry-After`

### Dual-Layer Data Hygiene

Layer A sanitizes JSON text at the edge. It recursively cleans object keys,
strings, arrays, and nested objects, removing invisible Unicode format controls,
bidi marks, zero-width characters, exotic tag characters, and unsafe controls.
It also applies NFC normalization and trims whitespace before Zod validation.

Layer C scrubs binary files outside the edge runtime:

- PNG and JPEG files are re-encoded without EXIF, XMP, ICC, comments, PNG text
  chunks, or ancillary credential metadata.
- PDFs are rebuilt with document info, XMP metadata, associated files, and
  embedded-file attachments removed.
- Outputs are reopened and checked before being returned.

This provides structural metadata and credential removal. It is not a
statistical or model-specific watermark-removal implementation.

### Structured Observability

Each request receives a UUID trace ID propagated in the `x-trace-id` response
header. The tracer records:

- Request ingress
- Circuit-breaker check
- Idempotency check
- Schema validation
- Handler execution

Spans and request-level audit records include timestamps, status codes,
durations, and structured attributes. Logs are written to stdout and persisted
to PocketBase when configured.

### Chaos and Failure Testing

The chaos injector sends randomized malformed payloads, duplicate requests,
concurrent traffic bursts, and controlled downstream failures. It verifies:

- Malformed payloads return `400`
- Duplicate payloads return `409`
- Burst responses avoid `500 INTERNAL_ERROR`
- Injected failures trip the circuit breaker
- Open-circuit responses return `503 CIRCUIT_OPEN`
- `Retry-After` is present
- The health endpoint remains available

## Benchmarks and Test Results

| Check | Result |
| --- | --- |
| Unit tests | 31/31 passed |
| TypeScript type check | Passed |
| Python type check | 0 errors |
| Chaos burst | 180 concurrent requests |
| Burst status distribution | 75 × 200, 68 × 400, 37 × 409 |
| Unexpected server failures | 0 |
| Circuit-breaker trip | 3 injected failures → 503 |
| Circuit retry header | `Retry-After: 10` |
| PocketBase live integration | Idempotency 1→2, audit 1→3, telemetry 1→9 |
| Wrangler dry-run bundle | 27.75 KiB gzip |
| Docker Compose / Stirling-PDF | Compose definition structurally verified; full runtime execution pending Docker availability |

The PocketBase integration was exercised against PocketBase `0.40.5` with a
live Wrangler Worker. The media scrubber passed direct image/PDF processing,
CLI processing, FastAPI health checks, and upload/path scrubbing checks.

## Local Development

Start the primary Docker services:

```bash
cd docker
docker compose up -d
```

Primary services:

- REM Worker: `http://localhost:8787`
- PocketBase Admin: `http://localhost:8090/_/`
- Stirling-PDF UI: `http://localhost:8080`
- Mock webhook: `http://localhost:8788`

Run the unit suite:

```bash
pnpm typecheck
pnpm test
```

Run the chaos profile:

```bash
docker compose --profile chaos run --rm --build chaos
```

## Repository

https://github.com/rubenjohnmendoza-dev/resilient-edge-middleware

## Engineering Notes

- Circuit-breaker state is currently isolate-local.
- PocketBase write failures fall back to in-memory idempotency for local
  availability; this reduces cross-isolate duplicate guarantees during outages.
- PocketBase admin credentials in Compose are development defaults only.
- Local infrastructure is defined via Docker Compose and structurally verified;
  full runtime execution, including the Stirling-PDF UI, remains pending local
  Docker availability.
- The media scrubber removes embedded metadata and credentials, not statistical
  model watermarks.
