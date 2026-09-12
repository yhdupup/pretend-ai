import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSkillRegistry,
  resetSkillRegistry,
  resolveSkillDirectory,
} from "../src/assist/skills/loader.js";
import { config } from "../src/server/config.js";

// Skill 加载与校验（PRD §9.2）：路径必须留在项目目录内，缺文件只禁用对应按钮。

function skillDir(root: string, name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

const SKILL_MD = `---
name: test-ai-style
description: 测试用 Skill
---

# 正文
`;

let root: string;
let cwdBackup: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aiwindow-skills-"));
  cwdBackup = process.cwd();
  resetSkillRegistry();
});

afterEach(() => {
  process.chdir(cwdBackup);
  resetSkillRegistry();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeRegistry(paths: Record<string, unknown>) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config", "skills.json"),
    JSON.stringify(paths),
  );
}

describe("resolveSkillDirectory（§9.2 路径边界）", () => {
  it("接受仓库相对路径", () => {
    const { dir, reason } = resolveSkillDirectory(root, "my-skill");
    expect(reason).toBeNull();
    expect(dir).toBe(path.join(root, "my-skill"));
  });

  for (const bad of [
    "../outside",
    "/Users/someone/secret",
    "C:\\skills\\x",
    "https://evil.example/skill",
    "~/skills",
    "a/../b",
    "",
  ]) {
    it(`拒绝非法路径 ${JSON.stringify(bad)}`, () => {
      const { dir, reason } = resolveSkillDirectory(root, bad || null);
      expect(dir).toBeNull();
      expect(reason).toBeTruthy();
    });
  }
});

describe("getSkillRegistry", () => {
  it("config/skills.json 不存在时不炸，两路都标不可用", () => {
    const registry = getSkillRegistry(root);
    expect(registry.configError).toBeTruthy();
    expect(registry.aiStyle.usable).toBe(false);
    expect(registry.analysis.usable).toBe(false);
  });

  it("目录缺失 -> missing（只禁用对应功能）", () => {
    writeRegistry({ aiStyleSkillPath: "ai", analysisSkillPath: "no-such-dir" });
    skillDir(root, "ai", {
      "SKILL.md": SKILL_MD.replace("test-ai-style", "ai"),
      "_meta.json": '{"version":"1.2.3","slug":"ai"}',
    });
    const registry = getSkillRegistry(root);
    expect(registry.aiStyle.status).toBe("ok");
    expect(registry.aiStyle.skillVersion).toBe("1.2.3");
    expect(registry.analysis.status).toBe("missing");
    expect(registry.analysis.reason).toContain("找不到");
  });

  it("缺 frontmatter -> invalid；非 UTF-8 -> invalid", () => {
    writeRegistry({ aiStyleSkillPath: "bad-fm", analysisSkillPath: "bad-enc" });
    skillDir(root, "bad-fm", { "SKILL.md": "# 没有 frontmatter\n" });
    const dir = skillDir(root, "bad-enc", { "SKILL.md": SKILL_MD });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      Buffer.from([0xff, 0xfe, 0x00, 0x41]),
    );
    const registry = getSkillRegistry(root);
    expect(registry.aiStyle.status).toBe("invalid");
    expect(registry.analysis.status).toBe("invalid");
  });

  it("contentHash 对目录内容敏感、对遍历顺序不敏感", () => {
    writeRegistry({ aiStyleSkillPath: "a", analysisSkillPath: "a" });
    const dir = skillDir(root, "a", {
      "SKILL.md": SKILL_MD,
      "references/b.md": "B\n",
      "references/a.md": "A\n",
    });
    const first = getSkillRegistry(root);
    const hash1 = first.aiStyle.contentHash;
    expect(hash1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.aiStyle.contentHash).toBe(first.analysis.contentHash); // 同一目录 -> 同一哈希

    resetSkillRegistry();
    fs.writeFileSync(
      path.join(dir, "references", "c.md"),
      "新增一个引用文件\n",
    );
    expect(getSkillRegistry(root).aiStyle.contentHash).not.toBe(hash1);
  });

  it("references 拼进指令文本（缺了细则模型只会写出「像但不对」的东西）", () => {
    writeRegistry({ aiStyleSkillPath: "a", analysisSkillPath: "a" });
    skillDir(root, "a", {
      "SKILL.md": SKILL_MD,
      "references/scene.md": "场景表的独特标记 ZZMARKER\n",
    });
    const registry = getSkillRegistry(root);
    expect(registry.aiStyle.instruction).toContain("ZZMARKER");
    expect(registry.aiStyle.instruction).toContain("# 正文");
  });
});

describe("真实项目 Skill（config/skills.json 指向的两份）", () => {
  it("两份都能加载，版本号与哈希非空", () => {
    const registry = getSkillRegistry(config.projectRoot);
    expect(registry.configError).toBeNull();
    expect(registry.aiStyle.usable).toBe(true);
    expect(registry.analysis.usable).toBe(true);
    expect(registry.aiStyle.skillId).toBeTruthy();
    expect(registry.analysis.skillVersion).toMatch(/\d/);
    expect(registry.analysis.contentHash).toMatch(/^sha256:/);
  });
});
