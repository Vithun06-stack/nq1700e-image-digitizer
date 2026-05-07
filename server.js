const http = require("http");
const fs = require("fs");
const path = require("path");
const { convertImageToEmbroidery } = require("./src/exportController");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limitBytes = 18 * 1024 * 1024) {
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

function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    send(res, 200, data, mimeTypes[path.extname(filePath)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/convert") {
    try {
      const raw = await readBody(req);
      const input = JSON.parse(raw);
      const result = convertImageToEmbroidery(input);
      send(res, 200, JSON.stringify(result));
    } catch (error) {
      send(res, 400, JSON.stringify({ error: error.message || "Conversion failed." }));
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
});

server.listen(port, "127.0.0.1", () => {
  try {
    if (process.stdout?.writable) {
      process.stdout.write(`NQ1700E digitizer running at http://127.0.0.1:${port}/\n`);
    }
  } catch {
    // Hidden Windows background launches may not have a writable console.
  }
});
