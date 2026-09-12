# AI 窗口（假装 AI）

一个装在自己电脑上的小工具：给朋友发一条链接，对方打开后以为在跟一个 AI 聊天，
其实屏幕这边是你在打字。

## 怎么开、怎么关

| 系统 | 启动 | 停止 |
|---|---|---|
| macOS | 双击 `start-macos.command`（首次得右键→打开，见下） | 双击 `stop-macos.command` |
| Windows | 双击 `start-windows.bat` | 双击 `stop-windows.bat` |

- 本机地址：`http://127.0.0.1:8787/`（你自己看的那个界面）
- 给对方的地址：**在工作台上点「复制链接」拿**，长这样 `https://xxxx.trycloudflare.com/s/<一串字母数字>`，
  结尾一定带 `/s/`。**裸域名不是链接**，发给别人只会看到一个 404。
- 启动窗口里那一行 `一次性引导地址：http://127.0.0.1:8787/api/local/bootstrap/…` **只能用一次**，
  用它进去之后，旧标签页、书签里留下的那条地址就会显示"本机控制会话已失效"，回启动窗口拿新的即可。
- 第一次在 macOS 上跑：右键点 `start-macos.command` → 选「打开」→ 弹窗里再点一次「打开」（系统的 Gatekeeper 拦一下）；
  之后就能正常双击了。详细步骤见 `docs/启动失败手动处理.md` §1。
- 出问题先看：`docs/启动失败手动处理.md`。

## 公网通道：这条链接是谁在提供

你给对方的那条地址不是本项目的服务器，走的是 **Cloudflare Tunnel**：

| 项 | 值 |
|---|---|
| 客户端 | `cloudflared`，版本钉在 **2025.4.2**（可用 `CLOUDFLARED_VERSION` 覆盖） |
| 来源 | GitHub release：<https://github.com/cloudflare/cloudflared/releases>（下载后按 `runtime-manifest.json` 里的 SHA-256 校验，另做 macOS codesign / Windows Authenticode 签名校验） |
| 用途 | 给你本机的 B 入口开一条临时公网地址，让对方用手机也能打开（免账号 Quick Tunnel） |
| 它会做什么 | 由**你本机主动**向 Cloudflare 边缘建立出站连接，B 的请求与响应经这条连接转发 |
| 它不会做什么 | 不上传你的文件、不需要你登录 Cloudflare、不读取也不改动你自己的 `~/.cloudflared` |
| 服务条款 | <https://www.cloudflare.com/website-terms/> |
| 隐私政策 | <https://www.cloudflare.com/privacypolicy/> |
| 功能文档 | <https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/> |

- 首次下载并运行它之前，启动脚本会把上面这段话打出来并要你**输入 `yes`**；不输入就中止，公网功能不启动。
  同意记录写在 `coding/bin/third-party-terms.json`（换了版本会重新问一次）。
- 这条通道是**临时域名**：服务重启或重连之后域名会变，**之前发出去的链接随之失效**，
  需要重新复制一条新的给对方。这不是故障。
- 本方案**不是端到端加密**：Cloudflare 作为第三方参与了流量转发。所以 B 页面上会提醒对方
  不要发敏感信息，这条工具也不该用来传真实密码、证件、住址这类东西。
- 只想在本机自己看效果、不给外面链接：启动前设 `TUNNEL_AUTOSTART=false`，公网功能就不开，
  本机 `http://127.0.0.1:8787/` 与 `http://127.0.0.1:8788/` 照常能用。

## 数据放在哪儿

- 对话与设置：`coding/data/dev.sqlite`（含 `-shm` / `-wal` 两个附属文件），只在你这台机器上。
- 运行日志：`logs/run-<时间>.log`。日志里不落明文对话内容。
- 只想结束某一次聊天：会话页底部「立即揭晓」旁边的**「结束并清理」**，对方那条链接立刻失效、记录不保留。
- 想把这台机器上的痕迹全部抹掉：先停止，再把 `coding/data/` 下那几个文件删了（目前没有“一键清除”，这一步得手动）。
- 第一次启动会联网下载两样东西（本项目专用的 Node 运行时 + 隧道客户端，见上面「公网通道」）；
  下完之后本机可以离线跑，只有“让对方能打开链接”这件事需要公网。

## 给开发/自己人看的

```bash
cd coding
npm run check          # 类型检查 + 单测 + 端到端 + 启动脚本自测 + 构建，全绿才算过
npm run check:skin     # A 端外观探针（真浏览器读计算样式 + 截图，自己起一次性实例，约 2 分钟）
npm run e2e:tunnel     # 真隧道端到端（要外网、约 1~2 分钟，所以没并进 check）
npm run dev            # 开发模式
```

历史实验脚本在 `docs/dev-archive/`。
`check:skin` 没并进 `check`：它要本机 Chromium 与真浏览器，属于验收那一次而不是每次提交。

## 许可

本项目源码公开，仅限非商业用途。商业使用、商业集成、收费服务及其他带有预期商业应用的使用均未获授权；完整条款见 [PolyForm Noncommercial License 1.0.0](LICENSE)。
