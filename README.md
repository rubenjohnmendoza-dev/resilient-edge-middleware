# Resilient Edge Middleware (REM)

REM is a Cloudflare Worker for zero-trust order intake. It combines strict Zod
validation, idempotent request handling, a sliding-window circuit breaker, and
structured request tracing.

## Local Docker stack

The stack contains:

- `rem`: Wrangler dev server on port `8787`
- `mock-webhook`: Node webhook receiver and API probe on port `8788`
- `chaos`: an on-demand chaos runner using `tests/chaos/chaos-injector.ts`

### Start the stack

From the repository root:

```bash
cd docker
docker compose up
```

The first run builds the image and starts the REM service and mock webhook.
Use `docker compose up --build` after changing dependencies, the Dockerfile, or
the container command.

Wait for both health checks to pass, then verify:

```bash
curl http://localhost:8787/health
curl http://localhost:8788/health
```

Expected responses include `{"status":"ok"}`.

### Submit an order

```bash
curl -X POST http://localhost:8787/orders \
  -H "content-type: application/json" \
  -d '{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "amount": 42.5,
    "currency": "AUD",
    "customerEmail": "customer@example.com",
    "timestamp": "2026-10-20T01:20:00.000Z"
  }'
```

The first request returns `200`. Sending the exact same body again within the
24-hour idempotency window returns `409` with `DUPLICATE_REQUEST`.

### Exercise the mock webhook

```bash
curl -X POST http://localhost:8788/webhook \
  -H "content-type: application/json" \
  -d '{"event":"order.created","id":"demo-001"}'

curl http://localhost:8788/last
```

The webhook returns `202` and acknowledges receipt. `/last` returns the most
recently received payload.

## Chaos testing

Run the chaos suite against the local stack:

```bash
cd docker
docker compose --profile chaos run --rm --build chaos
```

The injector:

- Resets local idempotency and circuit-breaker state.
- Sends randomized malformed JSON and schema-invalid payloads, asserting `400`.
- Sends a valid payload twice, asserting `200` then `409 DUPLICATE_REQUEST`.
- Floods the service with concurrent mixed traffic, asserting only `200`, `400`,
  `409`, or `503` responses and no `INTERNAL_ERROR`.
- Checks `/health` after the spike.
- Injects three simulated downstream failures through `x-chaos-fail: 1`, then
  asserts a normal request receives `503 CIRCUIT_OPEN` with `Retry-After`.
- Checks that the Worker remains healthy while the circuit is open.
- Resets state after the suite so the dev stack remains usable.

Optional load controls:

```bash
CHAOS_SPIKE_REQUESTS=20 CHAOS_BURSTS=2 \
  docker compose --profile chaos run --rm chaos
```

The supported variables are `CHAOS_SEED`, `CHAOS_SPIKE_REQUESTS`, and
`CHAOS_BURSTS`. The default run uses 60 concurrent requests per burst, three
bursts, and seed `20261020`.

## Local-only chaos hooks

The Compose service starts Wrangler with `CHAOS_MODE=true`. This enables:

- `POST /_chaos/reset`: clears the in-memory idempotency store and closes the
  circuit breaker.
- `x-chaos-fail: 1` on `POST /orders`: returns `503 CHAOS_FAILURE` and records a
  breaker failure.

These hooks exist only for local chaos testing and must not be enabled in
production.

## Dual-layer data hygiene

REM separates text hygiene from binary media hygiene.

### Layer A: edge text sanitization

`src/middleware/sanitize.ts` recursively sanitizes JSON keys, strings, arrays,
and nested objects. It removes Unicode format controls, including zero-width
characters, bidi marks, BOM/word joiners, soft hyphens, and the
U+E0000-U+E007F tag block. It also removes invisible C0/C1 controls, applies
Unicode NFC normalization, and trims leading/trailing whitespace.

The Worker calls `sanitizePayload` after `JSON.parse` and before Zod validation.
Genuinely invalid data is still rejected, while clean payloads pass through
semantically unchanged. Removing zero-width joiners intentionally changes
emoji sequences that rely on them.

### Layer C: media metadata scrubber

`service/scrub_media.py` handles PNG, JPEG, and PDF files that should not be
processed inside the edge Worker:

- Images are decoded, orientation-corrected, and re-encoded through Pillow
  without EXIF, XMP, ICC, comments, PNG text chunks, or ancillary credential
  metadata. This also removes C2PA/JUMBF APP/ancillary segments.
- PDFs are rebuilt through pikepdf with document info, XMP `/Metadata`,
  `/PieceInfo`, `/AF` associated files, and `/Names/EmbeddedFiles` attachments
  removed.
- Every output is reopened and verified for the targeted metadata before the
  request returns.

This is structural metadata and credential hygiene. It does not attempt
statistical or model-specific watermark removal, and image re-encoding changes
the file bytes.

Install and run the scrubber:

```bash
python -m venv .venv
```

PowerShell:

```powershell
.venv\Scripts\Activate.ps1
pip install -r service/requirements.txt
uvicorn service.scrub_media:app --host 127.0.0.1 --port 8090
```

macOS/Linux:

```bash
source .venv/bin/activate
pip install -r service/requirements.txt
uvicorn service.scrub_media:app --host 127.0.0.1 --port 8090
```

Upload a file for scrubbing:

```bash
curl -F "file=@input.jpg" \
  http://127.0.0.1:8090/scrub/upload \
  -o scrubbed.jpg
```

Scrub a path available to the local service:

```bash
curl -X POST http://127.0.0.1:8090/scrub \
  -H "content-type: application/json" \
  -d '{"path":"input.png"}'
```

Path access is constrained to `REM_SCRUB_ROOT`, which defaults to the process
working directory. Output defaults to `scrubbed/<filename>`. Uploads are limited
to 50 MB by default; override with `REM_MAX_UPLOAD_BYTES`.

The same scrubbing engine is available from the CLI:

```bash
python service/scrub_media.py input.png input.pdf --output-dir scrubbed
```

The edge Worker handles JSON text; local automation or a trusted backend handles
binary attachments by calling the media service and receiving scrubbed bytes.
The Python service is deliberately separate from the Worker so PDF/image
parsing and native libraries do not run in the edge runtime.

## Unit tests and type checking

On the host:

```bash
pnpm install
pnpm typecheck
pnpm test
```

Inside the built container:

```bash
docker compose run --rm --no-deps rem pnpm typecheck
docker compose run --rm --no-deps rem pnpm test
```

## Shutdown

```bash
cd docker
docker compose down -v
```

The idempotency store, circuit-breaker state, and trace store are in-memory and
isolate-local. A production deployment should use a Durable Object or SQLite
for shared idempotency and circuit state, and forward telemetry to a durable
collector.
