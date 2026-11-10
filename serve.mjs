// 独立启动宝盒哨兵服务，不依赖 magpie 的插件宿主。
// 用法：node serve.mjs
// 如果已有实例在跑（magpie 已通过插件把服务起起来了），什么都不做直接退出。
import { startServer } from "./lib/server.mjs";

const PORT = 3491;

async function alreadyRunning() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 800);
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json().catch(() => null);
      if (j && j.ok) return true;
    }
  } catch { /* 没在跑 */ }
  return false;
}

if (await alreadyRunning()) {
  console.log(`宝盒哨兵服务已经在运行了 (http://127.0.0.1:${PORT})，直接去 magpie 里打开「宝盒网络」即可。`);
  process.exit(0);
}

const info = await startServer({ options: { port: PORT } });
console.log(`宝盒哨兵服务已就绪: http://127.0.0.1:${info.port}`);
console.log("这个窗口最小化即可，关掉服务就停了");
process.on("SIGINT", async () => { await info.close(); process.exit(0); });
