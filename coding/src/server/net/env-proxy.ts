// 让进程内的全局 fetch 跟随系统代理（Node 24 起支持）。
//
// 为什么必须在入口最早处做：阶段3 的隧道探活是从**本机出去**访问
// https://<随机域名>.trycloudflare.com/api/public/health，而不是访问 127.0.0.1。
// 挂了代理的开发机经常出现「浏览器能打开、服务端探活却 ENOTFOUND」：
// 浏览器的 DNS 由代理在远端做，而 Node 直连时走本机 mDNSResponder ——
// 新注册的 trycloudflare 域名在本机 DNS 里会有一个负缓存窗口，探活就被误判成隧道挂了。
//
// ⚠️ 实测踩坑（阶段3 自测）：`process.env.NODE_USE_ENV_PROXY = "1"` **只对之后新起的进程有效**，
// Node 在主进程启动时就把它读死了，运行中改环境变量不影响已注册的 dispatcher。
// 真正在进程内生效的是 node:http 的 setGlobalProxyFromEnv()（Node 24+），两个都得做：
//   - setGlobalProxyFromEnv()：管当前进程（服务端探活走的就是这条）
//   - 设 process.env：管我们 spawn 出去的子进程（tsx watch 重启、自备隧道命令等）
//
// 不想跟随代理：启动前设 NODE_USE_ENV_PROXY=0（本模块只在未显式设置时补默认值）。
// NO_PROXY 里请保留 127.0.0.1、localhost，否则本机自调自都会绕远路。
import http from "node:http";

function applyProxyFromEnv(): { following: boolean; reason: string } {
  const setter = (http as unknown as { setGlobalProxyFromEnv?: () => void })
    .setGlobalProxyFromEnv;
  if (typeof setter !== "function") {
    return { following: false, reason: "NODE_BELOW_24" }; // 老版本 Node：退回默认行为，探活按直连算
  }
  try {
    setter(); // 读取 HTTP(S)_PROXY / NO_PROXY，注册成全局 dispatcher
    return { following: true, reason: "" };
  } catch {
    // 代理地址写错（例如缺协议）时不能让服务起不来，探活退回直连口径
    return { following: false, reason: "PROXY_ENV_INVALID" };
  }
}

if (process.env.NODE_USE_ENV_PROXY === undefined) {
  process.env.NODE_USE_ENV_PROXY = "1"; // 给子进程用
}
const applied =
  process.env.NODE_USE_ENV_PROXY === "0"
    ? { following: false, reason: "DISABLED_BY_USER" }
    : applyProxyFromEnv();

/** 供启动日志和 A 状态接口说明探活口径：不含代理地址，只说走不走。 */
export function proxyProbeMode(): { following: boolean; reason: string } {
  return applied;
}

export {};
