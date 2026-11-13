// 插件内置守望：取代 launchd 守护（com.zto.baohe-auth）。
// 设计红线（2026-11-13 用户拍板）：任何时候都不碰 UI、不拉起宝盒 app。
//   断网判据：公网 TCP 双检（223.5.5.5/114.114.114.114/1.1.1.1:53）——门户 10.10.9.2
//   只在公司网存在，在家「门户不可达」不是断网，不得据此自愈。
//   自愈唯一通道：`open -g ztoimbox://reauth`（-g 后台投递，不激活宝盒窗口）；
//   失败指数退避 6s→10min。宝盒没跑就绝不动手；只读日志注解原因。
//   每 60s 顺检 main.js 补丁（PATCH_MARKER 缺失才重打）。
// 宿主（magpie-bu）加载本模块即自动开跑；宿主重启（插件增删改）自动恢复。
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { readFile, stat, open, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

async function isAppRunning() {
  const pg = await run("/usr/bin/pgrep", ["-f", "宝盒lite.app/Contents/MacOS/宝盒lite"], 5000);
  return pg.code === 0 && pg.out.trim().length > 0;
}

const state = {
  running: false,
  intervalMs: 500,
  cooldownMs: 6000,
  lastAttempt: 0,
  startedAt: null,
  events: 0,
  healed: 0,
  failStreak: 0,       // 连续自愈失败次数（驱动冷却退避）
  netState: "unknown", // ok | offline_app_running | offline_no_app
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

  // 唯一自愈通道：无头协议（-g 后台投递，绝不激活宝盒窗口、不碰 UI）
  const open = spawn("/usr/bin/open", ["-g", "ztoimbox://reauth"], { stdio: "ignore", detached: true });
  open.unref();
  let ok = false;
  let detail = "";
  for (let i = 0; i < 10 && !ok; i++) {
    await sleep(400);
    const p = await internetProbe(1000);
    ok = p.ok;
    detail = p.detail;
  }
  if (ok) {
    state.healed += 1;
    state.failStreak = 0;
  } else {
    state.failStreak += 1;
  }
  state.lastResult = { method: "headless_protocol", success: ok, detail, at: new Date().toISOString() };
}

// 自愈失败后指数退避：6s → 12s → 24s … 封顶 10 分钟（外网真断时不空转轰炸宝盒）
function effectiveCooldown() {
  if (state.failStreak <= 0) return state.cooldownMs;
  return Math.min(state.cooldownMs * 2 ** state.failStreak, 600000);
}

async function tick() {
  if (state.busy || Date.now() - state.lastAttempt < effectiveCooldown()) return;
  state.busy = true;
  try {
    // 1. 公网双检 = 唯一断网判据（门户 10.10.9.2 只在公司网存在，
    //    在家「门户不可达」不是断网，绝不能据此触发自愈）
    const i1 = await internetProbe(800);
    if (i1.ok) {
      state.netState = "ok";
      await patchKeepCheck();
      return;
    }
    await sleep(150);
    const i2 = await internetProbe(1000);
    if (i2.ok) {
      state.netState = "ok";
      return;
    }

    // 2. 公网真断：宝盒没跑就绝不动手（不拉起宝盒 app）
    if (!(await isAppRunning())) {
      state.netState = "offline_no_app";
      return;
    }
    state.netState = "offline_app_running";

    // 3. 日志信号只做原因注解（只读，不碰 UI），走无头重连
    const signals = await readNewBreakSignals();
    const reason = signals[0] || `Internet dropped: ${i2.detail}`;
    await heal(reason);
    state.lastAttempt = Date.now();
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
