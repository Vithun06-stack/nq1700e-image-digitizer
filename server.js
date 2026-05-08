const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 25;
const REQUEST_LIMIT_BYTES = 18 * 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const runtime = {
  startedAt: new Date().toISOString(),
  root,
  host: normalizeHost(process.env.HOST),
  requestedPort: normalizePort(process.env.PORT, DEFAULT_PORT),
  port: null,
  urls: {},
  engine: {
    status: "not-loaded",
    pesExport: "unknown",
    dstExport: "unknown",
    lastCheckedAt: null,
    lastError: null
  },
  startupChecks: [],
  lastFatalError: null
};

let engineModule = null;

function timestamp() {
  return new Date().toISOString();
}

function safeWrite(line, stream = process.stdout) {
  try {
    if (stream?.writable) stream.write(`${line}\n`);
  } catch {
    // Hidden Windows process launches can have closed stdio handles.
  }
}

function log(message) {
  safeWrite(`[${timestamp()}] ${message}`);
}

function logError(message, error) {
  const details = error?.stack || error?.message || String(error || "");
  safeWrite(`[${timestamp()}] ERROR: ${message}\n${details}`, process.stderr);
}

function serializeError(error) {
  if (!error) return null;
  return {
    message: error.message || String(error),
    stack: error.stack || null,
    code: error.code || null
  };
}

process.on("uncaughtException", (error) => {
  runtime.lastFatalError = serializeError(error);
  logError("Uncaught exception captured. The server will keep reporting diagnostics.", error);
});

process.on("unhandledRejection", (reason) => {
  runtime.lastFatalError = serializeError(reason instanceof Error ? reason : new Error(String(reason)));
  logError("Unhandled promise rejection captured.", reason instanceof Error ? reason : new Error(String(reason)));
});

function normalizeHost(value) {
  const host = String(value || DEFAULT_HOST).trim();
  if (["127.0.0.1", "localhost", "0.0.0.0"].includes(host)) return host;
  log(`Unsupported HOST "${host}" requested; using ${DEFAULT_HOST}.`);
  return DEFAULT_HOST;
}

function normalizePort(value, fallback) {
  const port = Number(value || fallback);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  log(`Invalid PORT "${value}" requested; using ${fallback}.`);
  return fallback;
}

function displayHost(host) {
  return host === "0.0.0.0" ? "127.0.0.1" : host;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data, null, 2));
}

function readBody(req, limitBytes = REQUEST_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function getEmbroideryEngine() {
  if (engineModule?.convertImageToEmbroidery) return engineModule;
  try {
    engineModule = require("./src/exportController");
    if (!engineModule?.convertImageToEmbroidery) {
      throw new Error("src/exportController did not export convertImageToEmbroidery.");
    }
    runtime.engine.status = "active";
    runtime.engine.lastError = null;
    log("Embroidery engine loaded: ACTIVE");
    return engineModule;
  } catch (error) {
    runtime.engine.status = "failed";
    runtime.engine.lastError = serializeError(error);
    logError("Embroidery engine failed to load.", error);
    throw error;
  }
}

function resolveStaticPath(requestUrl) {
  const rawPath = requestUrl === "/" ? "/index.html" : requestUrl.split("?")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const resolved = path.resolve(path.join(root, `.${decoded}`));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function serveStatic(req, res) {
  const filePath = resolveStaticPath(req.url);
  if (!filePath) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, diagnosticHtml("Not found", `Could not find ${req.url}`), "text/html; charset=utf-8");
      return;
    }
    send(res, 200, data, mimeTypes[path.extname(filePath)] || "application/octet-stream");
  });
}

function diagnosticHtml(title, message) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:Arial,sans-serif;max-width:760px;margin:48px auto;line-height:1.5;color:#172025">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p>Check <a href="/health">/health</a> for startup diagnostics.</p>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function healthPayload() {
  return {
    status: "ok",
    app: "NQ1700E Image Digitizer",
    frontend: "active",
    backendApi: "active",
    embroideryEngine: runtime.engine.status,
    pesExport: runtime.engine.pesExport,
    dstExport: runtime.engine.dstExport,
    host: runtime.host,
    port: runtime.port,
    urls: runtime.urls,
    startedAt: runtime.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    startupChecks: runtime.startupChecks,
    lastFatalError: runtime.lastFatalError,
    engineError: runtime.engine.lastError
  };
}

async function handleConvert(req, res) {
  try {
    const { convertImageToEmbroidery } = getEmbroideryEngine();
    const raw = await readBody(req);
    const input = JSON.parse(raw);
    const result = convertImageToEmbroidery(input);
    sendJson(res, 200, result);
  } catch (error) {
    logError("POST /api/convert failed.", error);
    sendJson(res, runtime.engine.status === "failed" ? 503 : 400, {
      error: error.message || "Conversion failed.",
      diagnostics: {
        embroideryEngine: runtime.engine.status,
        engineError: runtime.engine.lastError
      }
    });
  }
}

function createHttpServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url.split("?")[0] === "/health") {
      sendJson(res, 200, healthPayload());
      return;
    }

    if (req.method === "POST" && req.url === "/api/convert") {
      await handleConvert(req, res);
      return;
    }

    if (req.url.split("?")[0] === "/api/convert") {
      sendJson(res, 405, { error: "Method not allowed. Use POST /api/convert." });
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }

    send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
  });

  server.on("clientError", (error, socket) => {
    logError("HTTP client error.", error);
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return server;
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const server = createHttpServer();
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject({ error, server });
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, runtime.host);
  });
}

async function listenWithFallback() {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = runtime.requestedPort + attempt;
    try {
      const server = await listenOnce(port);
      runtime.port = port;
      const hostForUrl = displayHost(runtime.host);
      runtime.urls = {
        frontend: `http://${hostForUrl}:${port}/`,
        api: `http://${hostForUrl}:${port}/api/convert`,
        health: `http://${hostForUrl}:${port}/health`
      };
      return server;
    } catch ({ error }) {
      if (["EADDRINUSE", "EACCES"].includes(error?.code) && attempt < MAX_PORT_ATTEMPTS - 1) {
        log(`Port ${port} is unavailable (${error.code}). Trying ${port + 1}.`);
        continue;
      }
      throw error;
    }
  }
  throw new Error("No available local ports found.");
}

function requestJson(method, pathname, body = null) {
  const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
  const host = displayHost(runtime.host);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      host,
      port: runtime.port,
      path: pathname,
      timeout: 15000,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": payload.length
      } : {}
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 400) {
            reject(new Error(`${method} ${pathname} returned ${res.statusCode}: ${parsed.error || raw}`));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(new Error(`${method} ${pathname} returned invalid JSON: ${error.message}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${pathname} timed out.`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startupProbeImage() {
  const width = 28;
  const height = 28;
  const rgba = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const stitchable = x >= 7 && x <= 20 && y >= 7 && y <= 20;
      rgba.push(stitchable ? 0 : 255, stitchable ? 0 : 255, stitchable ? 0 : 255, stitchable ? 255 : 0);
    }
  }
  return {
    fileName: "startup_probe.png",
    fileType: "image/png",
    fileSize: width * height * 4,
    hoopWidthIn: 4,
    hoopHeightIn: 4,
    maxColors: 2,
    stitchDensity: 0.4,
    fillSpacingMm: 0.4,
    stitchLengthMm: 2.5,
    minLineWidthMm: 1,
    removeTransparent: true,
    image: { width, height, rgba }
  };
}

async function runStartupValidation() {
  runtime.startupChecks = [];
  const record = (name, passed, detail) => {
    runtime.startupChecks.push({ name, passed, detail, checkedAt: new Date().toISOString() });
    log(`${passed ? "OK" : "FAIL"} startup check: ${name}${detail ? ` - ${detail}` : ""}`);
  };

  try {
    const health = await requestJson("GET", "/health");
    record("frontend/backend health endpoint", health.status === "ok", runtime.urls.health);
  } catch (error) {
    record("frontend/backend health endpoint", false, error.message);
  }

  try {
    const result = await requestJson("POST", "/api/convert", startupProbeImage());
    const pesOk = Boolean(result.files?.pes);
    const dstOk = Boolean(result.files?.dst);
    const stitchOk = Number(result.metadata?.stitchCount || 0) > 0;
    runtime.engine.status = "active";
    runtime.engine.pesExport = pesOk ? "active" : "failed";
    runtime.engine.dstExport = dstOk ? "active" : "failed";
    runtime.engine.lastCheckedAt = new Date().toISOString();
    record("embroidery engine", stitchOk, `${result.metadata?.stitchCount || 0} stitches generated`);
    record("PES export endpoint", pesOk, pesOk ? "PES bytes generated" : "missing PES output");
    record("DST export endpoint", dstOk, dstOk ? "DST bytes generated" : "missing DST output");
  } catch (error) {
    runtime.engine.status = "failed";
    runtime.engine.pesExport = "failed";
    runtime.engine.dstExport = "failed";
    runtime.engine.lastError = serializeError(error);
    record("embroidery conversion endpoint", false, error.message);
  }
}

function printBanner() {
  safeWrite("");
  safeWrite("------------------");
  safeWrite("NQ1700E Digitizer Running");
  safeWrite(`Frontend: ${runtime.urls.frontend}`);
  safeWrite(`Backend API: ${runtime.urls.api}`);
  safeWrite(`Health: ${runtime.urls.health}`);
  safeWrite(`Embroidery Engine: ${runtime.engine.status.toUpperCase()}`);
  safeWrite(`PES Export: ${String(runtime.engine.pesExport).toUpperCase()}`);
  safeWrite(`DST Export: ${String(runtime.engine.dstExport).toUpperCase()}`);
  safeWrite("------------------");
  safeWrite("");
}

async function main() {
  log("Starting NQ1700E Image Digitizer local server.");
  log(`Node.js ${process.version} on ${process.platform} ${process.arch}`);
  log(`Project root: ${root}`);
  log(`Requested bind: ${runtime.host}:${runtime.requestedPort}`);

  const server = await listenWithFallback();
  log(`HTTP server bound to ${runtime.host}:${runtime.port}`);
  await runStartupValidation();
  printBanner();

  process.on("SIGINT", () => {
    log("Shutdown requested with SIGINT.");
    server.close(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    log("Shutdown requested with SIGTERM.");
    server.close(() => process.exit(0));
  });
}

main().catch((error) => {
  logError("Startup failed.", error);
  process.exitCode = 1;
});
