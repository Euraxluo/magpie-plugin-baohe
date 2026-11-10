// baohe 探测/执行层：所有对宝盒的动作都收敛在这里。
// 只依赖本机既有设施：baohe-auth CLI（~/.local/bin）、launchd 守护、认证门户 10.10.9.2。
import { spawn, execFile } from "node:child_process";
import { readFile, stat, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_PATH = "/Applications/宝盒lite.app";
const MAIN_JS = APP_PATH + "/Contents/Resources/app/dist/main.js";
const BACKUP_JS = MAIN_JS + ".original";
const CLI = path.join(os.homedir(), ".local/bin/baohe-auth");
const LOG = path.join(os.homedir(), "Library/Logs/baohe-auth.log");
const ERR_LOG = path.join(os.homedir(), "Library/Logs/baohe-auth.err.log");
const PORTAL = "http://10.10.9.2";
const LABEL = "com.zto.baohe-auth";
const NOON_LABEL = "local.baohe.network-recovery.noon";
const PATCH_MARKER = "BAOHE_AUTH_PATCH_V1";
const REAUTH_URL = "ztoimbox://reauth";

function run(file, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ""), err: String(stderr || "") });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    const text = await res.text().catch(() => "");
    return { ok: true, status: res.status, text: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, text: String(e?.cause?.code || e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function probePortal(timeoutMs = 1500) {
  const r = await fetchWithTimeout(`${PORTAL}/?t=${Date.now()}`, timeoutMs);
  if (!r.ok) return { authed: false, detail: `门户不可达: ${r.text}` };
  if (r.text.includes("network is connected")) return { authed: true, detail: "network is connected" };
  return { authed: false, detail: `未认证/被重定向: ${r.text.slice(0, 120) || "(空响应)"}` };
}

async function probeInternet(timeoutMs = 2500) {
  const r = await fetchWithTimeout("https://223.5.5.5/resolve?name=www.baidu.com&type=A", timeoutMs);
  if (r.ok && r.status === 200 && r.text.includes('"Status"')) return { ok: true, detail: "DoH 解析正常 (223.5.5.5)" };
  return { ok: false, detail: r.ok ? `HTTP ${r.status}` : r.text };
}

async function appStatus() {
  const pg = await run("/usr/bin/pgrep", ["-f", "宝盒lite.app/Contents/MacOS/宝盒lite"]);
  const pid = pg.out.split("\n").map((s) => s.trim()).filter(Boolean)[0] || null;
  if (!pid) return { running: false, pid: null, detail: "未运行" };
  const ps = await run("/bin/ps", ["-p", pid, "-o", "lstart="]);
  let version = "";
  try {
    const pkg = JSON.parse(await readFile(APP_PATH + "/Contents/Resources/app/package.json", "utf8"));
    version = pkg.version || "";
  } catch { /* 版本读不到就算了 */ }
  return { running: true, pid, started: ps.out.trim(), version, detail: `PID ${pid}${version ? " · " + version : ""}` };
}

async function patchStatus() {
  try {
    const c = await readFile(MAIN_JS, "utf8");
    const patched = c.includes(PATCH_MARKER) && c.includes("ztoimbox://reauth");
    return {
      patched,
      backup: existsSync(BACKUP_JS),
      detail: patched ? "已注入（夜间拦截已解除 + 无头重连可用）" : "未注入（夜间 00:00~06:00 会强制断网）",
    };
  } catch (e) {
    return { patched: false, backup: false, detail: `main.js 读取失败: ${e.message}` };
  }
}

async function daemonStatus() {
  const pg = await run("/usr/bin/pgrep", ["-f", "baohe-auth watch"]);
  const pid = pg.out.split("\n").map((s) => s.trim()).filter(Boolean)[0] || null;
  const lc = await run("/bin/launchctl", ["list", LABEL]);
  let launchd = "未加载";
  if (lc.code === 0) {
    const out = lc.out;
    const first = out.split("\n")[0].split("\t");
    if (out.trimStart().startsWith("{")) {
      // 新版 launchctl list <label> 输出 plist 风格 dict
      const pid = out.match(/"PID" = (\d+)/)?.[1];
      const last = out.match(/"LastExitStatus" = (\d+)/)?.[1];
      launchd = pid ? `已加载（PID ${pid}）` : `已加载（当前未运行，上次退出码 ${last ?? "?"}）`;
    } else {
      launchd = first[0] === "-" ? `已加载（上次退出码 ${first[1]}，当前未运行）` : `已加载（PID ${first[0]}，上次退出码 ${first[1]}）`;
    }
  }
  return {
    watching: !!pid,
    pid,
    launchd,
    cli: existsSync(CLI),
    detail: pid ? `watch PID ${pid} · ${launchd}` : `watch 未运行 · ${launchd}`,
  };
}

async function tailFile(file, bytes = 12000) {
  try {
    const st = await stat(file);
    const fh = await open(file, "r");
    try {
      const start = Math.max(0, st.size - bytes);
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString("utf8").split("\n").filter(Boolean).slice(-40).join("\n");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

async function logs() {
  const [out, err] = await Promise.all([tailFile(LOG), tailFile(ERR_LOG)]);
  return { out, err };
}

async function reauth() {
  const before = await probePortal(1200);
  const r = await run("/usr/bin/open", [REAUTH_URL], 5000);
  await sleep(2500);
  const after = await probePortal(1500);
  return { triggered: r.code === 0, before, after };
}

async function patchApply() {
  if (!existsSync(CLI)) return { ok: false, out: "", err: "找不到 ~/.local/bin/baohe-auth" };
  const r = await run(CLI, ["patch", "apply"], 30000);
  return { ok: r.code === 0, out: r.out, err: r.err };
}

async function daemonRestart() {
  const uid = os.userInfo().uid;
  let r = await run("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`], 10000);
  if (r.code !== 0) {
    const plist = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
    await run("/bin/launchctl", ["unload", plist]);
    r = await run("/bin/launchctl", ["load", plist], 10000);
  }
  await sleep(1500);
  const st = await daemonStatus();
  return { ok: r.code === 0, kickstart: r.out + r.err, daemon: st };
}

async function appRestart() {
  await run("/usr/bin/killall", ["宝盒lite"], 5000);
  await sleep(2000);
  const r = await run("/usr/bin/open", ["-a", "宝盒lite"], 8000);
  await sleep(4000);
  const st = await appStatus();
  return { ok: r.code === 0, app: st };
}

export async function status() {
  const [app, portal, internet, patch, daemon, log] = await Promise.all([
    appStatus().catch((e) => ({ detail: "探测失败: " + e.message })),
    probePortal().catch((e) => ({ authed: false, detail: e.message })),
    probeInternet().catch((e) => ({ ok: false, detail: e.message })),
    patchStatus().catch((e) => ({ detail: e.message })),
    daemonStatus().catch((e) => ({ detail: e.message })),
    logs().catch(() => ({ out: "", err: "" })),
  ]);
  return { app, portal, internet, patch, daemon, log, at: new Date().toISOString() };
}

export const actions = { reauth, patchApply, daemonRestart, appRestart, status, logs };
