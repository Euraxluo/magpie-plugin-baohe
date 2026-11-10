// 带路页：把这个 magpie 页面框架自身导航到插件的本地服务。
//
// 页面的 CSP 是 connect-src 'none'，fetch/XHR/WebSocket 全被禁止 ——
// 唯一能做的联网动作是把自己导航到别处（magpie 文档明说）。所以这里不探测，
// 直接跳：目标由 magpie.page.service 声明，桌面窗口跳 127.0.0.1:port，
// magpie web（浏览器在另一台机器）跳 bridge 给的 magpie.service 中继地址。
//
// WebKit 对不可达目标不报错（location.replace 失败也当没事），5 秒后文档还活着
// 就说明没跳成，换成可操作的提示。
(async () => {
  const DEFAULT_PORT = 3491;
  let port = DEFAULT_PORT;
  let theme = "";
  let tokens = null;
  let service = "";

  try {
    const t = await window.magpie?.ready; // { dark, lang, tokens }
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
      if (t.tokens && typeof t.tokens === "object") tokens = t.tokens;
    }
  } catch { /* 没有 bridge 就退回默认主题 */ }
  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch { /* 旧版 magpie 没有 service */ }
  try {
    const o = await window.magpie?.options?.get?.();
    if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port);
  } catch { /* 没有 options 就用默认端口 */ }

  const q = new URLSearchParams();
  if (theme) q.set("theme", theme);
  if (tokens && Object.keys(tokens).length) {
    try { q.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(tokens))))); }
    catch { /* 编码不了就只带主题 */ }
  }
  const qs = q.toString();
  const target = service
    ? `${service}${service.endsWith("/") ? "" : "/"}?${qs}`
    : `http://127.0.0.1:${port}/${qs ? "?" + qs : ""}`;

  location.replace(target);

  setTimeout(function () {
    const said = document.getElementById("said");
    if (!said) return;
    said.textContent = `本地宝盒哨兵服务没有在运行（127.0.0.1:${port}）。在 magpie 里开关一次本插件，或运行: node serve.mjs`;
    if (document.getElementById("boot-retry")) return;
    const btn = document.createElement("button");
    btn.id = "boot-retry";
    btn.type = "button";
    btn.textContent = "重试";
    btn.style.cssText = "margin-left:10px;padding:2px 12px;font:inherit;cursor:pointer;";
    btn.addEventListener("click", function () { location.reload(); });
    said.parentNode.appendChild(btn);
  }, 5000);
})();
