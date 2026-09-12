# browser-checks —— 真浏览器探针（归档，不是交付物）

这些脚本是 2026-09-11/12 几轮验收期间写的一次性驱动，验收完从 `coding/` 挪到这里归档。
**不要**当成回归测试用：路径写死（本机 Chromium for Testing 的绝对路径、个别还依赖 `/tmp/tok.txt`），
换台机器就跑不动。

留着的理由只有一个：它们记录了**当时到底是怎么量的**，将来复现某个截图/日志争议时能照着改。

| 文件 | 当初用来量什么 | 要浏览器 | 要令牌 |
|---|---|---|---|
| `tmp-explore.mjs` | 把 A 真实 DOM 结构打出来（别靠猜写断言） | 是 | 是（读 `/tmp/tok.txt`，连的是本机 8787） |
| `tmp-dump.mjs` | 解锁 → 建会话 → 打印会话页与 B 页的真实文案 | 是 | 是（同上） |
| `tmp-debug.mjs` | 打两个页面之间所有 `/api` 请求与响应（查「B 的消息到底发出去没有」） | 是 | 是（同上） |
| `tmp-status.mjs` | 照用户 A 的方式（书签/历史直接开 8787）打开工作台，定位「读不到通道状态」 | 是 | 是（同上） |
| `tmp-keyboard.mjs` | PRD §5.5/§6.7 键盘规则 + §7.4.3 自动折叠，用 CDP `Input.imeSetComposition` 造组词态 | 是 | 是（同上） |
| `tmp-ui-full.mjs` | 最大的一份：把「脚本测不到、要人看」的手工项跑一遍（阶段一~四，公网项 SKIP） | 是 | 是（同上） |
| `tmp-ui1.mjs` | 上面那份的早期小样 | 是 | 是（同上） |
| `tmp-unlock-selftest.mjs` | 用一次性引导地址解锁 → 查工作台读得到状态 → 跑验收页 19 项 | 是 | 是（命令行传引导地址） |
| `verify-a-ui-change.mjs` | 改完 A 界面后自证：公网那一行收成什么样（无标题、按需按钮、第三方块已删）、会话页「处置正文」「深度反推」两个按钮是不是**常驻**（没提问时灰着但看得到，`title` 说清为什么灰）、档位夹在中间且改了真存进服务端、两步各写各的格子（润色不动摘要、反推不动正文）、分析框在正文框上面、B 收不收得到。**自己起 8897/8898 的一次性实例和临时库，不动用户那台 8787。** | 是 | 否（令牌在进程环境里） |
| `verify-owner-avatar.mjs` | A 的身份头像三件事：⌘V 的两条来源（`files` 与只有 `items` 的微信/网页图）都能换头像、焦点在输入框里时粘贴**不许**被头像抢走、选文件与拖进来同一条通路；再验揭晓前 B 侧 `preview`/`poll`/页面里一个图字节都没有、揭晓后 `<img>` 真绘制出来（naturalWidth 256、绘制 64px）。自起 8897/8898 与 `data/tmp-avatar.sqlite`，退出时删库。⚠️ 2026-09-13 起首页有**两个**头像区，所有选择器都收进 `OWNER_FIELD`（`nth(0)`）里；「揭晓前页面上没有 `.avatar-img`」这句已经不成立（B 顶部本来就有假 AI 的默认图），改成守「没有 A 上传的那张 `data:` 图」。同一次还把它自己过期的两处认了账：按钮早改叫「进入对话 →」、「创建新会话」这个文案根本不存在。现 19 项。 | 是 | 否 |
| `verify-ai-avatar.mjs` | 假 AI 那张脸的全链路（2026-09-13）：创建窗口里那个「四选一」下拉确实删了；没上传时预览是打包进 `/assets/` 的默认图，且**真取到**（`naturalWidth=256`；当初丢 `public/` 根路径时就是死在这一步，B 端一片空白）；粘贴/选文件都压成 160×160（身份档仍是 256，两档互不带走）；两个头像区共用一条粘贴监听时**碰过哪个归哪个**；「用回默认头像」退回；建完会话 B 顶上就是 A 上传的那张、按 42px 画、而且**不再多发一次默认图的请求**；不上传的会话则证明 `/assets/ai-avatar-<哈希>.jpg` 出得来、200、带一年 `immutable`。自起 8899/8900 与 `data/tmp-ai-avatar.sqlite`，退出删库。 | 是 | 否 |
| `verify-rules-output.mjs` | 规则模式两个按钮的**实物长什么样**：处置正文全篇只有一条引导语（不逐句带「我这边的情况是：」）、点两次不套娃、浓郁档把单句也拆成编号两行；深度反推铺到六步、第一步原样引用对方那句话、编号不跳号、最后一步是「检查一遍」；发出去之后 B 的正文与过程都按换行排、逐字播放能看到多行、播完自动折叠；`preview` 下发 `roundLimit=10 / timeLimitMinutes=20`、首页卡片写 20 分钟，最后把**自己那个临时库**里的 `reveal_deadline_at` 挪到过去，等真·到点揭晓，验弹窗那句是「这轮对话到了 20 分钟」。22 项。 | 是 | 否 |
| `probe-public-link-shapes.mjs` | 用户报「另一台电脑打开是 404」：把链接的各种残缺形态（只发域名、`/s/`、少了 id、旧地址、已停）逐个从公网取一遍，看真实状态码。用来区分「地址不对 / 这条隧道已作废 / 服务没跑 / 本机网络不通」。**同样自起 8897/8898，会真开一条隧道。** | 否 | 否 |

## 要用它们，前提按种类分

**A 类（`tmp-*.mjs`，连用户那台 8787）**

1. `cd coding && npm i -D playwright-core`（本机已装，`playwright` 包不需要）；
2. 本机有 Chromium：脚本里写死的是 `~/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/…`；
3. 启动服务时要拿到**没被用过的一次性引导地址**（`node scripts/start.mjs --no-open` 的窗口里印着；
   它只能用一次，用完想再解锁就得重启服务）。

跑法：`cd coding && node ../docs/dev-archive/browser-checks/tmp-unlock-selftest.mjs "<引导地址>"`
（脚本得在 `coding/` 下运行才解析得到 `playwright-core`）。

**B 类（`verify-a-ui-change.mjs` / `verify-owner-avatar.mjs` / `verify-ai-avatar.mjs` / `verify-rules-output.mjs` / `probe-public-link-shapes.mjs`，自己起实例）**

- **得先拷回 `coding/` 才能跑**：`cp ../docs/dev-archive/browser-checks/verify-a-ui-change.mjs ./tmp-v.mjs && node tmp-v.mjs; rm tmp-v.mjs`。
  （Node 解析 `playwright-core` 是从脚本所在目录往上找 `node_modules`，放在归档目录里 `import` 不回来。）
- 不需要引导地址（令牌在自己进程的环境里），但要 `dist/` 是新的（先 `npm run build`）；
- `verify-a-ui-change.mjs` 要 Chromium；`probe-public-link-shapes.mjs` 只要外网，
  并且**会真开一条 trycloudflare 隧道**——连打会被限流（当时实测：连续起隧道会每 15~35 秒换一次地址）。
- 两者都会建再删自己的临时库（`data/tmp-probe.sqlite` / `data/tmp-ui.sqlite`），跑完自己停进程。

⚠️ 这些脚本**不进 `npm run check`**，也不该进：它们要真浏览器、真网络、真令牌，属于档3「真机那一次」。

> 例外：2026-09-12 前端换肤那份探针 `check-a-skin.mjs` **不住在这**，它在 `coding/scripts/`，入口 `cd coding && npm run check:skin`（24 项，含真发一条消息后读气泡计算样式）。原因是量的：`@playwright/test` 装在 `coding/node_modules`，Node 按脚本自身位置上溯解析模块，把它挪进本目录第一次跑就 `ERR_MODULE_NOT_FOUND`。本表里其余各份是历史归档，路径写死、不保证还能跑。

## 量出来的几个坑（B 类自起实例时最容易撞）

- **控制令牌就是 `LOCAL_CONTROL_TOKEN_SECRET` 那个串本身**：只要它 ≥16 字符、且 `AIWINDOW_LAUNCHER_TOKEN=1` 与它都来自 shell 环境（`config.ts` 的 `fromShellEnv` 两个条件），cookie 就填 `aiwindow_ctrl=<同一个串>`。探针里另起一个随机数当 cookie，会得到 `bootstrap 兑换失败 403`，看起来像「端口被别的实例占了」——本表 `verify-rules-output.mjs` 第一版就是这么白跑三轮。
- **B 的页面路径是 `/s/:id`**，`/sessions/:id` 是 A 那边的。打错拿到的是 Hono 的 `404 Not Found` 纯文本，很容易误判成「链接坏了」。
- **`/api/local/settings` 是拆开的三个端点**：`PUT /profile`、`/assist`、`/model`；`/assist` 的字段是扁平的 `{mode, aiStyleEnabled, analysisEnabled, styleLevel}`。整份 PUT 到 `/settings` 返回 404。
- **处理接口有 3 秒最小间隔**（`PROCESS_RATE_LIMIT_SECONDS`）：脚本里连点两次会被挡回「点得太快了」，现象是格子永远是空的。要么点之前 sleep 过 3.6 秒，要么认出那句提示再补点一次。
- **两种「预期内的 404」别算成回归**：B 首屏会先按已绑定探一次 `GET /api/public/sessions/:id`（没 claim 必然 404，是设计）；favicon 也还是 404（Backlog 里那条「favicon 返回 204」）。`verify-rules-output.mjs` 的㉑按 URL 放过这两类。
- **逐字播放的时长是算出来的**（`typeCharMs`：短摘要 45ms/字，长摘要压到地板 16ms/字，目标 5 秒左右）：探针等折叠要给够时间，本脚本用 130×120ms 的采样窗，别照抄旧的 45 次。
