import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../server/config.js";
import type {
  AssistFeature,
  SkillRef,
  SkillState,
  SkillStatus,
} from "../../shared/types.js";

/**
 * Skill 加载与校验（PRD §9.2）。
 *
 * 要点：
 * - 路径唯一来源是 `<项目根>/config/skills.json`，只允许**仓库相对路径**；
 * - Skill 不是可执行程序，只作为「版本化指令文本」交给模型；
 * - 路径缺失/文件无效 → 只把对应功能标成不可用，人工聊天照常（§9.2 倒数第 4 条）；
 * - 记录 skillId / skillVersion / contentHash，用于事后解释「同一份草稿为什么这次不一样」（§9.2 末条）。
 *
 * 不做热重载：改了 Skill 文件要重启才生效（记进开发文档 §九 的已知限制）。
 */

const CONFIG_RELATIVE = path.join("config", "skills.json");

export interface LoadedSkill extends SkillState {
  /** 目录是否存在且路径合法（不含内容校验）。 */
  usable: boolean;
  /** 交给模型的指令文本；不可用时为 null。 */
  instruction: string | null;
}

export interface SkillRegistry {
  aiStyle: LoadedSkill;
  analysis: LoadedSkill;
  /** config/skills.json 本身的问题（读不到/不是 JSON），null = 没问题。 */
  configError: string | null;
  projectRoot: string;
}

interface DeclaredPaths {
  aiStyleSkillPath: string | null;
  analysisSkillPath: string | null;
  error: string | null;
}

function readDeclaredPaths(projectRoot: string): DeclaredPaths {
  const file = path.join(projectRoot, CONFIG_RELATIVE);
  if (!fs.existsSync(file)) {
    return {
      aiStyleSkillPath: null,
      analysisSkillPath: null,
      error: "config/skills.json 不存在",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // 不回传 JSON 解析器的原文：它会带上绝对路径（§18.6）。
    return {
      aiStyleSkillPath: null,
      analysisSkillPath: null,
      error: "config/skills.json 不是合法 JSON",
    };
  }
  const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const pick = (key: string) =>
    typeof record[key] === "string" && record[key].trim()
      ? record[key].trim()
      : null;
  return {
    aiStyleSkillPath: pick("aiStyleSkillPath"),
    analysisSkillPath: pick("analysisSkillPath"),
    error: null,
  };
}

/**
 * 路径校验（§9.2「禁止 /Users/...、盘符、网络地址或 ../」）。
 * 返回 null 表示非法；同时给出人话原因（只回相对形态，不回绝对路径）。
 */
export function resolveSkillDirectory(
  projectRoot: string,
  declared: string | null,
): { dir: string | null; reason: string | null } {
  if (!declared)
    return { dir: null, reason: "config/skills.json 里没配这个路径" };
  const raw = declared.trim();
  if (!raw) return { dir: null, reason: "路径为空" };
  if (/[\\]/.test(raw))
    return { dir: null, reason: "路径不能含反斜杠或转义写法" };
  if (/^[a-zA-Z]:/.test(raw))
    return { dir: null, reason: "不允许 Windows 盘符绝对路径" };
  if (raw.startsWith("/") || raw.startsWith("~"))
    return { dir: null, reason: "不允许绝对路径，必须是仓库相对路径" };
  if (/:\/\//.test(raw) || /^[a-z]+:\/\//i.test(raw))
    return { dir: null, reason: "不允许网络地址" };
  if (raw.split("/").some((segment) => segment === ".." || segment === "")) {
    return { dir: null, reason: "路径不能含 .. 或空段" };
  }
  const absolute = path.resolve(projectRoot, raw);
  const root = path.resolve(projectRoot);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return { dir: null, reason: "路径解析后跑出了项目目录" };
  }
  return { dir: absolute, reason: null };
}

function readUtf8(file: string): string | null {
  const buffer = fs.readFileSync(file);
  try {
    // fatal: true —— 非法字节序列直接抛，避免把半截乱码当指令喂给模型。
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/** frontmatter 里必须有 name + description，否则视为「不是可识别的 SKILL.md 主指令」（§9.2）。 */
function parseFrontmatter(text: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (pair) fields[pair[1]] = pair[2].replace(/^["']|["']$/g, "");
  }
  return fields.name && fields.description ? fields : null;
}

function listContentFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else if (
        entry.isFile() &&
        (/\.(md|json|ya?ml)$/i.test(entry.name) || entry.name === "SKILL.md")
      )
        out.push(relative);
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * contentHash：目录内全部文本文件按相对路径字典序拼 `path\0content\0` 后 sha256。
 * 排序保证「同内容不同文件名顺序」哈希稳定，跨机器可比。
 */
function contentHash(dir: string): string {
  const digest = crypto.createHash("sha256");
  for (const relative of listContentFiles(dir)) {
    const text = readUtf8(path.join(dir, relative));
    digest.update(relative);
    digest.update("\0");
    digest.update(text ?? "<非 UTF-8>");
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function loadOne(
  feature: AssistFeature,
  projectRoot: string,
  declared: string | null,
  base: SkillStatus,
): LoadedSkill {
  const unusable = (status: SkillStatus, reason: string): LoadedSkill => ({
    feature,
    configuredPath: declared,
    status,
    reason,
    skillId: null,
    skillVersion: null,
    contentHash: null,
    usable: false,
    instruction: null,
  });

  if (base === "disabled") return unusable("disabled", "该功能已在配置里关闭");
  const { dir, reason } = resolveSkillDirectory(projectRoot, declared);
  if (!dir) return unusable("invalid", reason ?? "路径非法");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    return unusable("missing", "项目目录里找不到这个 Skill 目录");

  const skillFile = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillFile))
    return unusable("missing", "目录里没有 SKILL.md 主指令");
  const skillText = readUtf8(skillFile);
  if (skillText === null)
    return unusable("invalid", "SKILL.md 不是合法 UTF-8 文本");
  const frontmatter = parseFrontmatter(skillText);
  if (!frontmatter)
    return unusable(
      "invalid",
      "SKILL.md 缺少可识别的 frontmatter（name / description）",
    );

  let version = "0.0.0";
  const metaFile = path.join(dir, "_meta.json");
  if (fs.existsSync(metaFile)) {
    const metaText = readUtf8(metaFile);
    try {
      const meta = JSON.parse(metaText ?? "{}") as {
        version?: unknown;
        slug?: unknown;
      };
      if (typeof meta.version === "string" && meta.version)
        version = meta.version;
      if (typeof meta.slug === "string" && meta.slug)
        frontmatter.name = meta.slug;
    } catch {
      return unusable(
        "invalid",
        "_meta.json 不是合法 JSON，读不到 skillVersion",
      );
    }
  }

  // references/ 里的细则是这个 Skill 的一部分，缺了模型只会写出「像但不对」的东西。
  let instruction = skillText;
  const refsDir = path.join(dir, "references");
  if (fs.existsSync(refsDir) && fs.statSync(refsDir).isDirectory()) {
    for (const file of fs
      .readdirSync(refsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()) {
      const text = readUtf8(path.join(refsDir, file));
      if (text === null)
        return unusable("invalid", `references/${file} 不是合法 UTF-8 文本`);
      instruction += `\n\n<!-- references/${file} -->\n${text}`;
    }
  }

  return {
    feature,
    configuredPath: declared,
    status: "ok" as SkillStatus,
    reason: null,
    skillId: frontmatter.name,
    skillVersion: version,
    contentHash: contentHash(dir),
    usable: true,
    instruction,
  };
}

let cached: SkillRegistry | null = null;

export function getSkillRegistry(
  projectRoot: string = config.projectRoot,
): SkillRegistry {
  if (cached && cached.projectRoot === projectRoot) return cached;

  const declared = readDeclaredPaths(projectRoot);
  const aiStyle = loadOne(
    "AI_STYLE",
    projectRoot,
    declared.aiStyleSkillPath,
    "ok",
  );
  const analysis = loadOne(
    "ANALYSIS_SUMMARY",
    projectRoot,
    declared.analysisSkillPath,
    "ok",
  );
  cached = {
    aiStyle,
    analysis,
    configError: declared.error,
    projectRoot,
  };
  return cached;
}

/** 测试专用：换项目根或改了 Skill 文件后重跑。 */
export function resetSkillRegistry(): void {
  cached = null;
}

export function toSkillRef(skill: LoadedSkill): SkillRef {
  return {
    feature: skill.feature,
    skillId: skill.skillId ?? "unknown",
    skillVersion: skill.skillVersion ?? "0.0.0",
    contentHash: skill.contentHash ?? "unset",
  };
}

/** 给 /api/local/status 用的瘦身视图（不带指令文本）。 */
export function toPublicSkillState(skill: LoadedSkill): SkillState {
  return {
    feature: skill.feature,
    configuredPath: skill.configuredPath,
    status: skill.status,
    reason: skill.reason,
    skillId: skill.skillId,
    skillVersion: skill.skillVersion,
    contentHash: skill.contentHash,
  };
}
