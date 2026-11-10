// @euraxluo/magpie-plugin-baohe：在 magpie 窗口里加一个「宝盒网络」页面。
//
// 两件事：
//   1. 作为 OpenCode v1 插件被 magpie 的 Bun 宿主加载（不注册任何供应商，只借宿主的进程起服务）。
//   2. 在加载时起一个本地 HTTP 服务（默认 127.0.0.1:3491，package.json 的 magpie.options.port 可改），
//      窗口里的页面把自己导航过来，面板与 magpie 主题同源直连。
//      服务对本机宝盒 (zbox-lite) 生效：状态探测、无头重连、补丁、守护管理。
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

// 宿主进程加载即起默认端口；magpie 调用导出的 server() 时带上 options，可换端口。
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
