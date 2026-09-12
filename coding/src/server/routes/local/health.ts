import { Hono } from "hono";
import type { Context } from "hono";

// 阶段5：A 入口的存活探针（PRD §12.2 第 15 步「本机两个健康检查通过后启动隧道」）。
//
// 为什么现在才加：阶段1~4 有意让 health 只存在于 B 入口，A 入口不多暴露任何东西。
// 但启动脚本必须能回答「8787 上跑的是不是本项目」—— 只看 TCP 能不能连通，
// 会把别人占用的端口误判成自己，然后既不报错也不开工作台。
//
// 这个端点的暴露面被刻意压到最小：
// - 响应只有 {ok, service:"a", probe} 三个字段，不含版本、路径、参数、会话、端口任何信息
//   （与 B 侧同一口径；少了 serverTime 也没人用，脚本只比 probe 那一个串）；
// - 不需要 Cookie（脚本没有浏览器会话），但 Host + Origin 校验照旧生效（见 local-auth），
//   所以外部域名指向 127.0.0.1 也问不出东西，它只能被本机浏览器/本机进程读到。
// - 不写访问日志：脚本每 250ms 探一次，会淹掉日志。
//
// 为什么必须回显 probe（开发文档 §5.6 的「是不是本项目」判据）：
// 只看「有没有 200」会把三种情况混为一谈 —— 别人的服务恰好也回 200、代理/缓存把上次响应喂回来、
// 或者本机跑着一个端口配置不同的旧实例。随机串对不上就说明不是我们要的那个进程。
// 口径与阶段3 的 B 侧 /api/public/health 完全一致（只认 [A-Za-z0-9_-]{1,64}，其它一律当没传）。

const app = new Hono();

function echoProbe(raw: string | undefined): string | null {
  return raw && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

function healthBody(c: Context) {
  return {
    ok: true as const,
    service: "a" as const,
    probe: echoProbe(c.req.query("probe")),
  };
}

app.get("/", (c) => c.json(healthBody(c)));

export default app;
