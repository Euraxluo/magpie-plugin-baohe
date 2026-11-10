// 宝盒哨兵本地服务：waypoint 页把自己导航过来后，真 UI 由这里提供。
// 本机自用（127.0.0.1 + Host 白名单挡 DNS rebinding + Origin 白名单挡跨站），
// 不设 token：没有值得偷的东西，动作全部是本机幂等操作。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { actions, status } from "./baohe.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_PORT = 3491;
// 本机自用（127.0.0.1 + Host 白名单 + Origin 白名单即可），不设 token：
// 服务只绑回环、动作全部幂等或本机操作，没有值得偷的东西。

let OWN = new Set();
let HOSTS = new Set();
let appHtml = null;

function originAllowed(req) {
  const o = req.headers.origin;
  return o === undefined || o === "null" || OWN.has(o);
}

function hostAllowed(req) {
  return HOSTS.has(String(req.headers.host || "").toLowerCase());
}

function corsHeaders(req) {
  const o = req.headers?.origin;
  const allow = o && OWN.has(o) ? o : "null";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    vary: "Origin",
  };
}

function send(req, res, code, body, type = "application/json; charset=utf-8", cors = true) {
  const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  const headers = {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(cors ? corsHeaders(req) : {}),
  };
  res.writeHead(code, headers);
  res.end(data);
}

async function readBody(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

async function handle(req, res) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (!hostAllowed(req)) return send(req, res, 403, { error: "Host 不对（DNS rebinding 防护）" });
  if (p === "/api/ping") return send(req, res, 200, { ok: true, name: "magpie-plugin-baohe", version: "0.3.0" });
  if (!originAllowed(req)) return send(req, res, 403, { error: "Origin 不允许" });
  // CORS 预检不带自定义头（没有 token），必须放在 token 校验之前：
  // 沙箱框架 opaque origin 发带自定义头的 fetch 一定先发 OPTIONS，拦它等于拦掉真请求。
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  // 只读与写操作都不设 token（本机回环 + Host/Origin 白名单已挡住跨站与 rebinding）
  if (req.method === "GET" && p === "/api/status") return send(req, res, 200, await status());
  if (req.method === "GET" && p === "/api/logs") return send(req, res, 200, await actions.logs());



  if (req.method === "POST" && p === "/api/reauth") return send(req, res, 200, await actions.reauth());
  if (req.method === "POST" && p === "/api/patch") return send(req, res, 200, await actions.patchApply());
  if (req.method === "POST" && p === "/api/watcher") {
    const { action } = await readBody(req);
    if (!["start", "stop"].includes(action)) return send(req, res, 400, { error: "action 必须是 start|stop" });
    return send(req, res, 200, await actions.watcherControl(action));
  }
  if (req.method === "POST" && p === "/api/legacy-uninstall") return send(req, res, 200, await actions.legacyUninstall());
  if (req.method === "POST" && p === "/api/app-restart") {
    const body = await readBody(req);
    if (body?.confirm !== true) return send(req, res, 400, { error: "需要 {confirm:true}" });
    return send(req, res, 200, await actions.appRestart());
  }

  return send(req, res, 404, { error: "no route " + p });
}

async function loadAppHtml() {
  if (!appHtml) {
    appHtml = await readFile(join(here, "app.html"), "utf8");
  }
  return appHtml;
}

export async function startServer({ options } = {}) {
  const port = Number(options?.port) > 0 ? Number(options.port) : DEFAULT_PORT;
  HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  OWN = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, "null"]);
  appHtml = null;
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/" || u.pathname === "/index.html") {
      if (!hostAllowed(req)) return send(req, res, 403, { error: "Host 不对" });
      loadAppHtml()
        .then((html) => send(req, res, 200, html, "text/html; charset=utf-8", false))
        .catch((e) => send(req, res, 500, { error: e.message }));
      return;
    }
    if (u.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    handle(req, res).catch((e) => {
      try { send(req, res, 500, { error: String(e?.message || e) }); } catch { /* 已响应 */ }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return { port, close: () => new Promise((r) => server.close(r)) };
}
