"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { loadConfig } = require("./config");
const { StandaloneRuntime } = require("./runtime");

const SITE_SOURCE = path.resolve(__dirname, "../../../adapters/github/site");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isAuthorized(req, config) {
  if (config.allowNoAuth) return true;
  const auth = req.headers.authorization || "";
  if (config.dashboardToken && auth.startsWith("Bearer ")) {
    return safeEqual(auth.slice("Bearer ".length), config.dashboardToken);
  }
  if (config.dashboardPassword && auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const user = idx >= 0 ? decoded.slice(0, idx) : "";
    const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
    return safeEqual(user, config.dashboardUser) && safeEqual(pass, config.dashboardPassword);
  }
  return false;
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("invalid JSON body"));
      }
    });
  });
}

function serveStatic(req, res, pathname) {
  const fileName = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(SITE_SOURCE, fileName);
  const rel = path.relative(SITE_SOURCE, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const ext = path.extname(candidate);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(candidate).pipe(res);
}

function createServer(runtime, config) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true, scheduler_running: Boolean(runtime.timer), in_flight: runtime.inFlight });
        return;
      }
      if (url.pathname === "/readyz") {
        const ready = runtime.readiness();
        sendJson(res, ready.ok ? 200 : 503, ready);
        return;
      }
      if (!isAuthorized(req, config)) {
        res.writeHead(401, {
          "Content-Type": "application/json; charset=utf-8",
          "WWW-Authenticate": 'Basic realm="Cron Dispatcher"',
        });
        res.end('{"error":"unauthorized"}\n');
        return;
      }

      if (req.method === "GET" && url.pathname === "/dashboard-data/summary.json") {
        sendJson(res, 200, runtime.summary());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/jobs") {
        sendJson(res, 200, { jobs: runtime.summary().jobs });
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/run$/);
      if (req.method === "POST" && runMatch) {
        const body = await readJson(req);
        const result = await runtime.tick({ jobId: decodeURIComponent(runMatch[1]), forceDisabled: Boolean(body.force_disabled) });
        sendJson(res, 202, { ok: true, result });
        return;
      }
      const enableMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (req.method === "PATCH" && enableMatch) {
        const body = await readJson(req);
        if (typeof body.enabled !== "boolean") {
          sendJson(res, 400, { error: "enabled boolean is required" });
          return;
        }
        const override = runtime.setEnabled(decodeURIComponent(enableMatch[1]), body.enabled);
        sendJson(res, 200, { ok: true, override });
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        serveStatic(req, res, url.pathname);
        return;
      }
      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || String(err) });
    }
  });
}

async function main() {
  const config = loadConfig();
  if (!config.allowNoAuth && !config.dashboardPassword && !config.dashboardToken) {
    console.error("Set DASHBOARD_PASSWORD or DASHBOARD_TOKEN, or ALLOW_NO_AUTH=true for local-only testing.");
    return 1;
  }
  const runtime = new StandaloneRuntime(config);
  runtime.start();
  const server = createServer(runtime, config);
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`Standalone cron dispatcher listening on http://${config.host}:${config.port}`);
  const shutdown = () => {
    server.close(() => {
      runtime.stop();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { createServer, isAuthorized, readJson };
