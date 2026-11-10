// @euraxluo/magpie-plugin-baohe：在 magpie 窗口里加一个「宝盒网络」页面。
//
// 三件事：
//   1. 作为 OpenCode v1 插件被 magpie 的 Bun 宿主加载。
//   2. 加载即启动内置守望（lib/watcher.mjs）—— 本插件取代 launchd 守护 com.zto.baohe-auth：
//      断网三源检测 + 无头协议重连 + UI 点击兜底 + 补丁自动重打。
//   3. 起本地 HTTP 服务（默认 127.0.0.1:3491），窗口里的页面把自己导航过来，
//      面板与 magpie 主题同源直连，可看守望状态/手动触发动作/启停守望。
import "./lib/watcher.mjs";
import { startServer } from "./lib/server.mjs";

const DEFAULT_PORT = 3491;
let current = null; // { port, close }

function pickPort(options) {
  const p = Number(options?.port);
  return p > 0 && p <= 65535 ? p : DEFAULT_PORT;
}

async function ensureServer(options) {
  const port = pickPort(options);
  if (current && current.port === port) return current;
  if (current) await current.close().catch(() => null);
  current = await startServer({ options: { port } });
  console.log(`[magpie-plugin-baohe] listening on http://127.0.0.1:${current.port}`);
  return current;
}

ensureServer({ port: DEFAULT_PORT }).catch((e) => console.error("[magpie-plugin-baohe] could not start:", e?.message || e));

export default {
  id: "baohe",
  server: async (input, options) => {
    await ensureServer(options || { port: DEFAULT_PORT }).catch((e) =>
      console.error("[magpie-plugin-baohe] restart failed:", e?.message || e)
    );
    return {};
  },
};
