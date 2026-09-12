import fs from "node:fs";
import { afterAll } from "vitest";
import os from "node:os";
import path from "node:path";

// 测试环境的进程级隔离。必须在任何服务端模块被 import 之前跑（vitest 的 setupFiles 保证这点，
// 因为 config.ts 是在模块求值时读 env 的）。
//
// 为什么要单独一个临时 SQLite 文件：
//  1. 不允许测试写开发者本机正在用的 data/dev.sqlite（那是真实数据）；
//  2. vitest 会用多个 worker 并行跑不同测试文件，大家共用一个库文件时，一个文件里的
//     cleanupAll()/清理动作会删掉另一个文件正在断言的会话，表现为随机失败。
//  3. 顺带保证隧道不会在测试里被自动拉起来（真实隧道要联网、还会改域名）。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwindow-test-"));
process.env.LOCAL_DATA_PATH = path.join(dir, "test.sqlite");
process.env.TUNNEL_AUTOSTART = "false";
// 测试里也不去解析 cloudflared 客户端的二进制路径
delete process.env.PUBLIC_TUNNEL_COMMAND;
delete process.env.PUBLIC_URL_PATTERN;
// 阶段4：开发者的 .env.local 里可能有真模型 key。测试进程绝不能拿它去联网 ——
// initCredentialsFromEnv() 只在 src/server/index.ts 里调用（测试走 createLocalApp，不经过那里），
// 这里再把 config 的那份也清掉，双保险。
process.env.USER_MODEL_API_KEY = "";
process.env.USER_MODEL_BASE_URL = "";
process.env.USER_MODEL_ID = "";

function removeDir() {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 光靠 process.on("exit") 清不干净：vitest 的 worker 是线程，线程退出不会走主进程的 exit 钩子，
// 实测一段时间下来 tmp 里堆了八百多个 aiwindow-test-* 空目录。
// 这里三条都挂上：文件跑完（afterAll）、worker 卸载（teardown）、主进程退出（exit）。
afterAll(removeDir);
if (typeof process !== "undefined" && "on" in process) {
  process.on("exit", removeDir);
  process.on("beforeExit", removeDir);
}
