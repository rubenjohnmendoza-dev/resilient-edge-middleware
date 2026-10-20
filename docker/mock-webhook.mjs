import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8788);
let lastPayload = null;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function timestamp() {
  return new Date().toISOString();
}

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "mock-webhook" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/last") {
    sendJson(response, 200, { lastPayload });
    return;
  }

  if (request.method === "POST" && url.pathname === "/webhook") {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendJson(response, 400, { error: "Invalid JSON", code: "INVALID_JSON" });
      return;
    }

    lastPayload = payload;
    console.log(
      JSON.stringify({
        timestamp: timestamp(),
        event: "webhook.received",
        payload,
      }),
    );
    sendJson(response, 202, {
      received: true,
      id: payload?.id ?? null,
      receivedAt: timestamp(),
    });
    return;
  }

  sendJson(response, 404, { error: "Not found", code: "NOT_FOUND" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      timestamp: timestamp(),
      event: "mock-webhook.ready",
      port,
    }),
  );
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
