// 插件内置守望：取代 launchd 守护（com.zto.baohe-auth）。
// 算法等价移植自 baohe-auth-cli 的 controller.monitor_tick：
//   检测三源：宝盒实时日志断网信号（瞬时高置信）→ 门户 10.10.9.2 双检 → 公网 TCP 双检
//   自愈两通道：ztoimbox://reauth 无头协议（锁屏/熄屏有效）→ baohe-auth click UI 兜底
//   6s 冷却；每 60s 顺检 main.js 补丁，被升级抹掉就自动重打。
// 宿主（magpie-bu）加载本模块即自动开跑；宿主重启（插件增删改）自动恢复。
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { readFile, stat, open, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORTAL = process.env.BAOHE_PORTAL_URL || "http://10.10.9.2/";
const EXPECTED = "network is connected";
const DNS_TARGETS = [
  ["223.5.5.5", 53],
  ["114.114.114.114", 53],
  ["1.1.1.1", 53],
];
const BREAK_SIGNALS = [
  "ZNetworkAuth:break",
  "auth-break",
  "夜间退出上网认证",
  "网络认证状态变化:  3",
  "无法连接到认证服务器",
  "ZNetworkAuth:status: 3",
  "网络认证权限校验失败",
];
const HOME = os.homedir();
const CLI = path.join(HOME, ".local/bin/baohe-auth");
const LOG_BASE = path.join(HOME, "Library/Application Support/zbox-lite");
const MAIN_JS = "/Applications/宝盒lite.app/Contents/Resources/app/dist/main.js";
const PATCH_MARKER = "BAOHE_AUTH_PATCH_V1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(file, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ""), err: String(stderr || "") });
    });
  });
}

// ---------- 探测 ----------

async function portalProbe(timeoutMs = 1200) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${PORTAL}?t=${Date.now()}`, { signal: ctl.signal });
    const text = await res.text().catch(() => "");
    if (text.includes(EXPECTED)) return { ok: true, detail: "network is connected" };
    return { ok: false, detail: `门户未认证/被重定向: ${text.slice(0, 80)}` };
  } catch (e) {
    return { ok: false, detail: `门户不可达: ${e?.cause?.code || e?.name || e}` };
  } finally {
    clearTimeout(timer);
  }
}

function tcpProbe(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function internetProbe(timeoutMs = 800) {
  for (const [h, p] of DNS_TARGETS) if (await tcpProbe(h, p, timeoutMs)) return { ok: true, detail: `${h}:${p}` };
  return { ok: false, detail: "公网 DNS 全部不可达" };
}

// ---------- 宝盒实时日志 ----------

async function findLatestLog() {
  try {
    for (const d of await readdir(LOG_BASE)) {
      if (!d.startsWith("log_v2_")) continue;
      const dir = path.join(LOG_BASE, d);
      let subdirs;
      try { subdirs = await readdir(dir); } catch { continue; }
      let best = null;
      for (const sd of subdirs) {
        const f = path.join(dir, sd, "temp.log");
        if (!existsSync(f)) continue;
        try { const st = await stat(f); if (!best || st.mtimeMs > best.mtimeMs) best = { f, mtimeMs: st.mtimeMs }; } catch {}
      }
      if (best) return best.f; // log_v2_* 目录通常只有一个，取其最新 temp.log
    }
  } catch { /* 无日志目录 */ }
  return null;
}

const logWatch = { path: null, pos: 0 };

async function readNewBreakSignals() {
  if (!logWatch.path || !existsSync(logWatch.path)) {
    logWatch.path = await findLatestLog();
    if (!logWatch.path) return [];
    try { logWatch.pos = (await stat(logWatch.path)).size; } catch { logWatch.pos = 0; }
  }
  let st;
  try { st = await stat(logWatch.path); } catch { logWatch.path = null; return []; }
  if (st.size < logWatch.pos) logWatch.pos = 0; // 轮转
  if (st.size === logWatch.pos) return [];
  try {
    const fh = await open(logWatch.path, "r");
    try {
      const len = st.size - logWatch.pos;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, logWatch.pos);
      logWatch.pos += len;
      const text = buf.toString("utf8");
      const signals = [];
      for (const line of text.split("\n")) {
        for (const sig of BREAK_SIGNALS) {
          if (line.includes(sig)) { signals.push(`[${sig}] ${line.trim().slice(0, 120)}`); break; }
        }
      }
      return signals;
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

// ---------- 守望循环 ----------

const state = {
  running: false,
  intervalMs: 500,
  cooldownMs: 6000,
  lastAttempt: 0,
  startedAt: null,
  events: 0,
  healed: 0,
  lastEvent: null,   // { reason, at }
  lastResult: null,  // 最近一次自愈结果
  lastPatchCheck: 0,
  lastPatchEvent: null,
  timer: null,
  busy: false,
};

async function patchKeepCheck() {
  if (Date.now() - state.lastPatchCheck < 60000) return;
  state.lastPatchCheck = Date.now();
  try {
    const c = await readFile(MAIN_JS, "utf8");
    if (c.includes(PATCH_MARKER)) return;
    if (!existsSync(CLI)) return;
    const r = await run(CLI, ["patch", "apply"], 30000);
    state.lastPatchEvent = { at: new Date().toISOString(), ok: r.code === 0, out: (r.out || r.err).slice(0, 200) };
    console.log("[baohe-watcher] patch auto-reapply:", r.code === 0 ? "ok" : r.err || r.out);
  } catch { /* 读不到就下轮再说 */ }
}

async function heal(reason) {
  state.events += 1;
  state.lastEvent = { reason, at: new Date().toISOString() };
  console.log(`[baohe-watcher] ⚡ 断网检测到: ${reason}`);

  // 通道1：无头协议（锁屏/熄屏有效）
  const open = spawn("/usr/bin/open", ["ztoimbox://reauth"], { stdio: "ignore", detached: true });
  open.unref();
  let ok = false;
  let detail = "";
  for (let i = 0; i < 6 && !ok; i++) {
    await sleep(350);
    const p = await portalProbe(1000);
    ok = p.ok;
    detail = p.detail;
  }
  if (ok) {
    state.healed += 1;
    state.lastResult = { method: "headless_protocol", success: true, detail, at: new Date().toISOString() };
    return;
  }

  // 通道2：UI 点击兜底（需要 CLI 的辅助功能点击）
  if (existsSync(CLI)) {
    const r = await run(CLI, ["click"], 15000);
    const success = r.code === 0 && !/not found|失败|timeout/i.test(r.out);
    if (success) state.healed += 1;
    state.lastResult = { method: "ui_click", success, detail: (r.out || r.err).slice(0, 300), at: new Date().toISOString() };
    return;
  }
  state.lastResult = { method: "none", success: false, detail: "无头协议未恢复且缺少 baohe-auth CLI", at: new Date().toISOString() };
}

async function tick() {
  if (state.busy || Date.now() - state.lastAttempt < state.cooldownMs) return;
  state.busy = true;
  try {
    // 1. 宝盒实时日志信号（瞬时）
    const signals = await readNewBreakSignals();
    let reason = signals[0];

    // 2. 门户双检
    if (!reason) {
      const p1 = await portalProbe(1200);
      if (!p1.ok) {
        await sleep(150);
        const p2 = await portalProbe(1500);
        if (!p2.ok) reason = `Intranet auth dropped: ${p2.detail}`;
      }
    }

    // 3. 公网双检
    if (!reason) {
      const i1 = await internetProbe(800);
      if (!i1.ok) {
        await sleep(150);
        const i2 = await internetProbe(1000);
        if (!i2.ok) reason = `Internet dropped: ${i2.detail}`;
      }
    }

    if (reason) {
      await heal(reason);
      state.lastAttempt = Date.now();
    } else {
      await patchKeepCheck();
    }
  } catch (e) {
    console.error("[baohe-watcher] tick error:", e?.message || e);
  } finally {
    state.busy = false;
  }
}

function loop() {
  if (!state.running) return;
  tick();
  state.timer = setTimeout(loop, state.intervalMs);
}

export function start(intervalMs) {
  if (state.running) return status();
  if (Number(intervalMs) >= 250) state.intervalMs = Number(intervalMs);
  state.running = true;
  state.startedAt = new Date().toISOString();
  logWatch.path = null; // 重新定位日志（宝盒可能升级换了目录）
  console.log(`[baohe-watcher] watch started (interval ${state.intervalMs}ms)`);
  loop();
  return status();
}

export function stop() {
  if (!state.running) return status();
  state.running = false;
  clearTimeout(state.timer);
  state.timer = null;
  console.log("[baohe-watcher] watch stopped");
  return status();
}

export function status() {
  const { timer, busy, ...rest } = state;
  return { ...rest, cli: existsSync(CLI) };
}

// 宿主加载即自动开跑 —— 插件即守护
start();
