import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

// 阶段5 档1（开发文档 §六 档1）：准备层脚本的离线单测。
//
// 这一档的定位：不联网、不碰真用户的 .runtime / logs / node_modules。
// 所有被测函数都支持注入 root / runtimeDir / manifest，测试就在 os.tmpdir() 的临时目录里
// 跑完整的「下载 → 校验 → 落地」流程 —— 下载源用 file://，而 file:// 本身又要求清单显式开闸，
// 于是「测试路径」和「生产路径」是同一条代码，只是清单里多了一个键。
//
// 导入的是仓库根 scripts/ 下的 .mjs（准备层的真身）。vitest 的 root 是 coding/，
// 跨目录 import 对 node 环境没有影响；这些脚本只用 Node 内置模块，不需要编译。

const lib = await import("../../scripts/lib.mjs");
const nodeBootstrap = await import("../../scripts/node-bootstrap.mjs");
const verify = await import("../../scripts/verify-runtime.mjs");

const tempDirs: string[] = [];
function tempDir(prefix = "aiwindow-startup-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const REAL_TARGET = lib.platformTarget(); // darwin-arm64 / darwin-x64 / win-x64
const HEX64 = "a".repeat(64);

/** 写一份临时清单。默认把校验值指向一个假的 64 位哈希，测试里再按需替换。 */
function writeManifestFile(
  dir: string,
  {
    allowLocalFixture = false,
    version = "9.9.9",
    target = REAL_TARGET,
    sha256 = HEX64,
    artifact = null,
  } = {},
) {
  const manifest = {
    allowLocalFixture,
    node: {
      version,
      mirrorBase: "https://nodejs.org/dist",
      targets: {
        [target]: {
          artifact: artifact ?? `node-v${version}-${target}.${target.startsWith("win") ? "zip" : "tar.gz"}`,
          sha256,
        },
      },
    },
    cloudflared: {
      version: "2025.4.2",
      releaseUrl: "https://github.com/cloudflare/cloudflared/releases/download",
      targets: {},
    },
    paths: { runtimeDir: ".runtime", nodeDir: ".runtime/node" },
  };
  const file = path.join(dir, "runtime-manifest.json");
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`期望抛出 ${code}，但什么都没抛`);
}

async function expectRejectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (err) {
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`期望拒绝 ${code}，但成功了`);
}

describe("runtime-manifest.json 解析", () => {
  it("清单缺失时硬报错，不退化成「那就不校验」", () => {
    const dir = tempDir();
    expectCode(
      () => lib.loadManifest(path.join(dir, "nope.json")),
      "RUNTIME_MANIFEST_MISSING",
    );
  });

  it("不是合法 JSON 时报 RUNTIME_MANIFEST_INVALID", () => {
    const dir = tempDir();
    const file = path.join(dir, "runtime-manifest.json");
    fs.writeFileSync(file, "{ this is not json");
    expectCode(() => lib.loadManifest(file), "RUNTIME_MANIFEST_INVALID");
  });

  it("清单里没有当前平台的条目 → RUNTIME_MANIFEST_INCOMPLETE", () => {
    const dir = tempDir();
    const file = writeManifestFile(dir, { target: "some-other-target" });
    const manifest = lib.loadManifest(file);
    expectCode(
      () => lib.expectedChecksum(manifest, REAL_TARGET, "node"),
      "RUNTIME_MANIFEST_INCOMPLETE",
    );
  });

  it("校验值是 null（还没把关的平台）→ 拒绝下载，不静默放行", () => {
    const dir = tempDir();
    const file = writeManifestFile(dir);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.node.targets[REAL_TARGET].sha256 = null;
    fs.writeFileSync(file, JSON.stringify(raw));
    const manifest = lib.loadManifest(file);
    expectCode(
      () => lib.expectedChecksum(manifest, REAL_TARGET, "node"),
      "RUNTIME_MANIFEST_INCOMPLETE",
    );
  });

  it("哈希长度不对 / 不是十六进制 → 直接判清单被改坏", () => {
    for (const bad of ["abc123", "z".repeat(64), HEX64.slice(0, 63)]) {
      const dir = tempDir();
      const file = writeManifestFile(dir, { sha256: bad });
      const manifest = lib.loadManifest(file);
      expectCode(
        () => lib.expectedChecksum(manifest, REAL_TARGET, "node"),
        "RUNTIME_MANIFEST_INVALID",
      );
    }
  });

  it("仓库里那份真清单：每个支持的平台都有 64 位哈希或明确为 null", () => {
    const manifest = lib.loadManifest();
    expect(manifest.nodeTag).toMatch(/^v\d+\.\d+\.\d+$/);
    for (const target of ["darwin-arm64", "darwin-x64", "win-x64"]) {
      const entry = manifest.nodeTargets[target];
      expect(entry, `清单缺少 ${target}`).toBeTruthy();
      if (entry.sha256 === null) continue; // null = 明说「没把关」，下游会拒
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/i);
    }
    // 真清单绝不能带本地包开关：带上就等于给「本地塞二进制」开门。
    expect(manifest.raw.allowLocalFixture).toBeUndefined();
  });
});

describe("下载源：镜像只换主机，file:// 要清单开闸", () => {
  it("AIWINDOW_NODE_BASE 换主机，但文件名与校验值不变", () => {
    const dir = tempDir();
    const manifest = lib.loadManifest(writeManifestFile(dir));
    const url = lib.nodeArchiveUrl(manifest, REAL_TARGET, {
      AIWINDOW_NODE_BASE: "https://npm.internal.example/mirror/",
    });
    expect(url).toBe(
      `https://npm.internal.example/mirror/v9.9.9/${manifest.nodeTargets[REAL_TARGET].artifact}`,
    );
    // 写了 KEY= 但没填值 ≠ 换镜像（拼出相对路径会更难查）
    const same = lib.nodeArchiveUrl(manifest, REAL_TARGET, { AIWINDOW_NODE_BASE: "  " });
    expect(same.startsWith("https://nodejs.org/dist/")).toBe(true);
  });

  it("清单没开 allowLocalFixture 时拒绝 file:// 源（生产路径上没有本地包这条路）", async () => {
    const dir = tempDir();
    const payload = path.join(dir, "payload.tar.gz");
    fs.writeFileSync(payload, "whatever");
    await expectRejectCode(
      lib.downloadAndVerify(`file://${payload}`, path.join(dir, "out"), HEX64),
      "LOCAL_FIXTURE_NOT_ALLOWED",
    );
    // 闸门在下载之前，所以连 .part 都不该出现
    expect(fs.existsSync(`${path.join(dir, "out")}.part`)).toBe(false);
  });

  it("开闸后：先落 .part，哈希对上才改名；对不上删掉 .part", async () => {
    const dir = tempDir();
    const payload = path.join(dir, "payload.bin");
    fs.writeFileSync(payload, "假包内容");
    const good = lib.sha256File(payload);

    const dest = path.join(dir, "nested", "payload.bin");
    await lib.downloadAndVerify(`file://${payload}`, dest, good, {
      localFixture: true,
    });
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);

    // 校验不过：目标文件不能出现（.part 也不能留下）
    const badDest = path.join(dir, "nested", "bad.bin");
    const err = await expectRejectCode(
      lib.downloadAndVerify(`file://${payload}`, badDest, HEX64, {
        localFixture: true,
      }),
      "CHECKSUM_MISMATCH",
    );
    expect(err.message).toContain("actual=");
    expect(fs.existsSync(badDest)).toBe(false);
    expect(fs.existsSync(`${badDest}.part`)).toBe(false);
  });

  it("边下边报进度：字节数单调增加，最后一格是 100%", async () => {
    const dir = tempDir();
    const payload = path.join(dir, "big.bin");
    fs.writeFileSync(payload, "x".repeat(5000));
    const seen = [];
    await lib.downloadAndVerify(`file://${payload}`, path.join(dir, "out.bin"), lib.sha256File(payload), {
      localFixture: true,
      onProgress: (got, total) => seen.push([got, total]),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(([got]) => got > 0)).toBe(true);
    const last = seen.at(-1);
    expect(last[1]).toBe(5000);
    expect(Math.floor((last[0] / last[1]) * 100)).toBe(100);
  });

  it("进度打印器：TTY 里刷同一行，非 TTY 时每行一条，且不会把异常抛出下载", () => {
    const lines = [];
    const print = lib.makeProgressPrinter({
      label: "正在下载 Node",
      everyMs: 0,
      tty: true,
      write: (t) => lines.push(t),
    });
    print(1024, 4096);
    expect(lines.at(-1)).toMatch(/^\r.*正在下载 Node：0\.0 MB \/ 0\.0 MB 25%/);
    print(4096, 4096);
    expect(lines.at(-1)).toMatch(/100%.*\n$/);
    // 没有 content-length（total=0）时不报百分比，但也不能崩
    expect(() => print(10, 0)).not.toThrow();
    expect(lines.at(-1)).toContain("KB/s");
    expect(lines.at(-1)).not.toContain("%");
  });

  it("下载中途卡住：到点就停，不把用户晾在原地（NETWORK_STALLED）", async () => {
    const dir = tempDir();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("x".repeat(10)); // 先给一点字节，之后永远不再给
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const err = await expectRejectCode(
        lib.downloadFile(
          `http://127.0.0.1:${port}/stall.bin`,
          path.join(dir, "out.bin.part"),
          { stallMs: 400 },
        ),
        "NETWORK_STALLED",
      );
      expect(err.message).toContain("卡住");
    } finally {
      server.close();
    }
  }, 20_000);
});

/**
 * 造一个「看起来像 Node 发行包」的 tar.gz：解压后有 bin/node。
 * bin/node 是被真 exec 的脚本，跑起来就把清单里钉的版本号打出来 ——
 * checkNodeExecutable 的判定（版本对不上算没装）因此是真的在被测。
 */
function buildFakeNodePackage(dir, { version, target }) {
  const stage = path.join(dir, `node-${version}-${target}`);
  fs.mkdirSync(path.join(stage, "bin"), { recursive: true });
  const exeName = target.startsWith("win") ? "node.exe" : "node";
  const script = path.join(stage, "bin", exeName);
  // Windows 上 .exe 不能是脚本；这套测试只在非 win 平台跑真下载流程。
  fs.writeFileSync(script, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  fs.writeFileSync(path.join(stage, "LICENSE.txt"), "fake");
  const ext = target.startsWith("win") ? "zip" : "tar.gz";
  const archive = path.join(dir, `node-${version}-${target}.${ext}`);
  execFileSync("tar", ["-czf", archive, "-C", dir, path.basename(stage)]);
  fs.rmSync(stage, { recursive: true, force: true });
  return { archive, artifact: path.basename(archive) };
}

describe("项目专用 Node：下载 → 校验 → 解压 → 试跑", () => {
  it("校验通过后落到 .runtime/node/<版本>/<平台>/，并且能跑", async () => {
    const dir = tempDir();
    const { archive, artifact } = buildFakeNodePackage(dir, {
      version: "9.9.9",
      target: REAL_TARGET,
    });
    const file = writeManifestFile(dir, {
      artifact,
      sha256: lib.sha256File(archive),
      allowLocalFixture: true,
    });
    const manifest = lib.loadManifest(file);

    const result = await nodeBootstrap.installProjectNode({
      root: dir,
      manifest,
      target: REAL_TARGET,
      url: `file://${archive}`,
    });

    expect(result.installed).toBe(true);
    expect(result.version).toBe("9.9.9");
    const home = lib.nodeHome(REAL_TARGET, "v9.9.9", dir);
    expect(result.home).toBe(home);
    expect(path.relative(dir, home)).toBe(
      path.join(".runtime", "node", "v9.9.9", REAL_TARGET),
    );
    // 落地结构：非 win 平台可执行文件在 bin/ 下（引导层的 shell 也按这个形状找）
    const exe = lib.nodeExePath(home, REAL_TARGET);
    expect(result.exe).toBe(exe);
    expect(fs.existsSync(exe)).toBe(true);
    expect(() => fs.accessSync(exe, fs.constants.X_OK)).not.toThrow();
    expect(verify.checkNodeExecutable(exe, "v9.9.9").ok).toBe(true);
    // 中间产物不留：下载目录里既没有压缩包也没有 .part
    const downloadDir = path.join(dir, ".runtime", "download");
    expect(fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : []).toEqual([]);
  });

  it("清单哈希与实际字节不符：不落地、不解压、不执行", async () => {
    const dir = tempDir();
    const { archive, artifact } = buildFakeNodePackage(dir, {
      version: "9.9.9",
      target: REAL_TARGET,
    });
    const file = writeManifestFile(dir, {
      artifact,
      sha256: HEX64, // 合法但不对的值
      allowLocalFixture: true,
    });
    const manifest = lib.loadManifest(file);
    const home = lib.nodeHome(REAL_TARGET, "v9.9.9", dir);

    const err = await expectRejectCode(
      nodeBootstrap.installProjectNode({
        root: dir,
        manifest,
        target: REAL_TARGET,
        url: `file://${archive}`,
      }),
      "CHECKSUM_MISMATCH",
    );
    expect(err.code).toBe("CHECKSUM_MISMATCH");
    // 校验失败发生在解压之前：既没有解压出来的目录，也没有可执行文件
    expect(fs.existsSync(path.join(home, "bin", "node"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".runtime", "download", artifact))).toBe(false);
    expect(
      fs.existsSync(path.join(dir, ".runtime", "download", `${artifact}.part`)),
    ).toBe(false);
  });

  it("已经装好且版本正确时不重复下载（幂等）", async () => {
    const dir = tempDir();
    const home = lib.nodeHome(REAL_TARGET, "v9.9.9", dir);
    fs.mkdirSync(path.join(home, "bin"), { recursive: true });
    const exe = path.join(home, "bin", "node");
    fs.writeFileSync(exe, "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 });
    fs.chmodSync(exe, 0o755);
    const manifest = lib.loadManifest(
      writeManifestFile(dir, { sha256: HEX64, artifact: "never-used" }),
    );

    const result = await nodeBootstrap.installProjectNode({
      root: dir,
      manifest,
      target: REAL_TARGET,
      url: "https://example.invalid/should-not-be-fetched",
    });
    expect(result).toMatchObject({ installed: false, reason: "ALREADY_READY" });
  });

  it("清单没开闸时，installProjectNode 也不会走 file://（闸门在入口，不只在底层）", async () => {
    const dir = tempDir();
    const { archive, artifact } = buildFakeNodePackage(dir, {
      version: "9.9.9",
      target: REAL_TARGET,
    });
    const manifest = lib.loadManifest(
      writeManifestFile(dir, {
        artifact,
        sha256: lib.sha256File(archive),
        allowLocalFixture: false,
      }),
    );
    await expectRejectCode(
      nodeBootstrap.installProjectNode({
        root: dir,
        manifest,
        target: REAL_TARGET,
        url: `file://${archive}`,
      }),
      "LOCAL_FIXTURE_NOT_ALLOWED",
    );
  });
});

describe("依赖指纹只认「会影响安装结果」的字段", () => {
  function fixture(pkg: unknown, lock = '{ "lockfileVersion": 3 }') {
    const dir = tempDir("depsfp-");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(path.join(dir, "package-lock.json"), lock);
    return dir;
  }

  it("改 scripts / description / 键的顺序：指纹不变（不该重装依赖）", () => {
    const a = fixture({
      name: "x",
      version: "0.1.0",
      description: "旧说明",
      scripts: { test: "vitest run" },
      dependencies: { hono: "^4.0.0" },
    });
    const b = fixture({
      dependencies: { hono: "^4.0.0" },
      scripts: { test: "vitest run", "e2e:startup": "node scripts/e2e-startup.mjs" },
      description: "新说明",
      name: "x",
      version: "0.1.0",
    });
    expect(lib.depsFingerprint(b)).toBe(lib.depsFingerprint(a));
  });

  it("依赖版本 / overrides / workspaces 变了：指纹变（要重装）", () => {
    const base = fixture({
      dependencies: { hono: "^4.0.0" },
      overrides: { foo: "1.0.0" },
      workspaces: ["apps/*"],
    });
    const before = lib.depsFingerprint(base);
    fs.writeFileSync(
      path.join(base, "package.json"),
      JSON.stringify({
        dependencies: { hono: "^4.1.0" },
        overrides: { foo: "1.0.0" },
        workspaces: ["apps/*"],
      }),
    );
    expect(lib.depsFingerprint(base)).not.toBe(before);
  });

  it("lock 文件哪怕只改一个字节也算变；缺 package.json 不崩", () => {
    const dir = fixture({ dependencies: {} }, '{ "a": 1 }');
    const before = lib.depsFingerprint(dir);
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{ "a": 2 }');
    expect(lib.depsFingerprint(dir)).not.toBe(before);
    fs.rmSync(path.join(dir, "package.json"));
    expect(() => lib.depsFingerprint(dir)).not.toThrow();
    // 空目录（两个文件都没有）也必须给出一个稳定的 64 位哈希，不能 NaN/undefined
    expect(lib.depsFingerprint(tempDir("empty-"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("依赖 stamp 判定（该不该重装）", () => {
  const root = lib.REPO_ROOT;
  const codingDir = lib.CODING_DIR;

  function stampFor({ depsKey, nodeVersion, platform, arch }) {
    return { depsKey, nodeVersion, platform, arch };
  }

  function probeWith(runtimeDir: string) {
    return verify.probe({ root, codingDir, runtimeDir, target: REAL_TARGET });
  }

  it("从没装过 → NEVER_INSTALLED", () => {
    const runtimeDir = tempDir("runtime-");
    expect(probeWith(runtimeDir).deps).toMatchObject({
      installed: false,
      reason: "NEVER_INSTALLED",
    });
  });

  it("指纹全对 → 跳过安装", () => {
    const runtimeDir = tempDir("runtime-");
    lib.writeStamp(
      "deps",
      stampFor({
        depsKey: verify.depsKey(codingDir),
        nodeVersion: lib.loadManifest().nodeTag,
        platform: process.platform,
        arch: process.arch,
      }),
      runtimeDir,
    );
    const report = probeWith(runtimeDir);
    expect(report.deps.installed).toBe(true);
    expect(report.deps.reason).toBeNull();
  });

  it("package-lock 变了 → LOCKFILE_CHANGED", () => {
    const runtimeDir = tempDir("runtime-");
    lib.writeStamp(
      "deps",
      stampFor({
        depsKey: "f".repeat(64),
        nodeVersion: lib.loadManifest().nodeTag,
        platform: process.platform,
        arch: process.arch,
      }),
      runtimeDir,
    );
    expect(probeWith(runtimeDir).deps.reason).toBe("LOCKFILE_CHANGED");
  });

  it("项目专用 Node 换版本 → NODE_VERSION_CHANGED（原生模块是按 ABI 编译的）", () => {
    const runtimeDir = tempDir("runtime-");
    lib.writeStamp(
      "deps",
      stampFor({
        depsKey: verify.depsKey(codingDir),
        nodeVersion: "v18.0.0",
        platform: process.platform,
        arch: process.arch,
      }),
      runtimeDir,
    );
    expect(probeWith(runtimeDir).deps.reason).toBe("NODE_VERSION_CHANGED");
  });

  it("平台或架构变了（整目录拷到另一台机器）→ PLATFORM_CHANGED", () => {
    for (const over of [
      { platform: "freebox" },
      { arch: "sparc64" },
    ]) {
      const runtimeDir = tempDir("runtime-");
      lib.writeStamp(
        "deps",
        stampFor({
          depsKey: verify.depsKey(codingDir),
          nodeVersion: lib.loadManifest().nodeTag,
          platform: process.platform,
          arch: process.arch,
          ...over,
        }),
        runtimeDir,
      );
      expect(probeWith(runtimeDir).deps.reason).toBe("PLATFORM_CHANGED");
    }
  });

  it("node_modules 被删了一半 → NODE_MODULES_MISSING（stamp 说得再好听也不信）", () => {
    const dir = tempDir();
    const runtimeDir = path.join(dir, ".runtime");
    const fakeCoding = path.join(dir, "coding");
    fs.mkdirSync(fakeCoding, { recursive: true });
    fs.writeFileSync(path.join(fakeCoding, "package.json"), '{"name":"x"}');
    fs.writeFileSync(path.join(fakeCoding, "package-lock.json"), "{}");
    lib.writeStamp(
      "deps",
      stampFor({
        depsKey: verify.depsKey(fakeCoding),
        nodeVersion: lib.loadManifest().nodeTag,
        platform: process.platform,
        arch: process.arch,
      }),
      runtimeDir,
    );
    const report = verify.probe({
      root,
      codingDir: fakeCoding,
      runtimeDir,
      target: REAL_TARGET,
    });
    expect(report.deps.nodeModules).toBe(false);
    expect(report.deps.reason).toBe("NODE_MODULES_MISSING");
  });

  it("stamp 文件坏了（半个 JSON）当没装过，而不是崩掉", () => {
    const runtimeDir = tempDir("runtime-");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "deps.stamp.json"), "{ 截断了");
    expect(lib.readStamp("deps", runtimeDir)).toBeNull();
    expect(probeWith(runtimeDir).deps.reason).toBe("NEVER_INSTALLED");
  });
});

describe("构建戳与产物检查", () => {
  it("三样产物齐了才算 build.ok（服务端入口 + 两个前端 index.html）", () => {
    // 本仓库跑测试前必然构建过（npm run check 的第一步就是 typecheck+build 产物存在），
    // 这一条同时充当「构建产物齐了」的守卫。
    expect(verify.checkBuild(lib.CODING_DIR).ok).toBe(true);
    const empty = tempDir();
    expect(verify.checkBuild(empty)).toMatchObject({
      ok: false,
      server: false,
      aFrontend: false,
      bFrontend: false,
    });
  });

  it("源码变了 → build 戳过期（不比对 mtime，比对内容哈希）", () => {
    const dir = tempDir();
    const runtimeDir = path.join(dir, ".runtime");
    const coding = path.join(dir, "coding");
    const before = verify.sourceKey(coding); // 空目录也有稳定值
    fs.mkdirSync(path.join(coding, "src"), { recursive: true });
    fs.writeFileSync(path.join(coding, "src", "a.ts"), "export const a = 1;\n");
    const withFile = verify.sourceKey(coding);
    expect(withFile).not.toBe(before);
    // 内容不变、只把 mtime 推后 → 指纹不变（git checkout 不该触发重建）
    const now = Date.now() / 1000 + 3600;
    fs.utimesSync(path.join(coding, "src", "a.ts"), now, now);
    expect(verify.sourceKey(coding)).toBe(withFile);
    lib.writeStamp("build", { sourceKey: withFile }, runtimeDir);
    expect(lib.readStamp("build", runtimeDir).sourceKey).toBe(withFile);
  });
});

describe("环境变量的读取优先级（脚本与服务端必须同一口径）", () => {
  it("shell > .env.local > .env.example > 默认值", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, ".env.example"),
      "LOCAL_PORT=7001\n# 注释\nQUOTED=\"7002\"\n",
    );
    fs.writeFileSync(path.join(dir, ".env.local"), "LOCAL_PORT=7003\n");

    expect(lib.resolveEnv("LOCAL_PORT", 8787, dir)).toBe("7003");
    expect(lib.resolvePort("LOCAL_PORT", 8787, dir)).toBe(7003);
    fs.rmSync(path.join(dir, ".env.local"));
    expect(lib.resolvePort("LOCAL_PORT", 8787, dir)).toBe(7001);
    // 模板值非法时退回默认值，而不是 NaN
    fs.writeFileSync(path.join(dir, ".env.example"), "LOCAL_PORT=not-a-port");
    expect(lib.resolvePort("LOCAL_PORT", 8787, dir)).toBe(8787);
    expect(lib.resolvePort("UNSET_KEY", 8787, dir)).toBe(8787);
  });

  it("端口默认值与文档一致：A 8787 / B 8788", () => {
    const empty = tempDir();
    expect(lib.resolvePort("LOCAL_PORT", 8787, empty)).toBe(8787);
    expect(lib.resolvePort("PUBLIC_PORT", 8788, empty)).toBe(8788);
  });
});

describe("启动前自检（§5.4）", () => {
  it("真项目根：通过", async () => {
    const start = await import("../../scripts/start.mjs");
    expect(start.preflightCheck({ root: lib.REPO_ROOT })).toMatchObject({
      ok: true,
    });
  });

  it("目录被挪走 / skills.json 缺失：报中文问题并给出退出码 ENV", async () => {
    const start = await import("../../scripts/start.mjs");
    const dir = tempDir();
    const report = start.preflightCheck({ root: dir });
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("coding/package.json");
    expect(report.problems.join("\n")).toContain("skills.json");
  });

  it("Skill 目录名被改：报「读不到」，并说明会降级成人工回复", async () => {
    const start = await import("../../scripts/start.mjs");
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "coding"), { recursive: true });
    fs.writeFileSync(path.join(dir, "coding", "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "coding", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".env.example"), "");
    fs.writeFileSync(path.join(dir, "runtime-manifest.json"), "{}");
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config", "skills.json"),
      JSON.stringify({
        aiStyleSkillPath: "并不存在的skill",
        analysisSkillPath: "/绝对/路径/skill",
      }),
    );
    const report = start.preflightCheck({ root: dir });
    expect(report.ok).toBe(false);
    const text = report.problems.join("\n");
    expect(text).toContain("并不存在的skill");
    expect(text).toContain("降级成人工回复");
    expect(text).toContain("不能写绝对路径");
  });

  it("skills.json 不是合法 JSON：报错但不把绝对路径写进消息里", async () => {
    const start = await import("../../scripts/start.mjs");
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "skills.json"), "{ broken");
    const report = start.preflightCheck({ root: dir });
    expect(report.problems.join(" ")).toContain("不是合法 JSON");
    expect(report.problems.join(" ")).not.toContain(dir);
  });
});

describe("退出码约定（开发文档 §5.11）", () => {
  it("码值稳定，.command/.bat 的分支才不会骗人", () => {
    expect(lib.EXIT).toMatchObject({
      OK: 0,
      ENV: 3,
      PORT: 4,
      ALREADY_RUNNING: 5,
      BUILD: 6,
      NETWORK: 7,
      PLATFORM: 8,
    });
  });
});
