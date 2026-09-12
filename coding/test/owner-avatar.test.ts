import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  DEFAULT_AI_AVATAR_FILE,
  MAX_AVATAR_DATA_CHARS,
  hasAvatarData,
  sanitizeAvatarData,
} from "../src/shared/avatars.js";
import { createLocalApp } from "../src/server/local-server.js";
import { createPublicApp } from "../src/server/public-server.js";
import {
  CONTROL_COOKIE_NAME,
  __resetBootstrapConsumedForTests,
  getControlToken,
} from "../src/server/security/control-token.js";
import { CLAIM_COOKIE_NAME } from "../src/server/routes/public/sessions.js";
import type {
  CreateSessionResponse,
  PreviewResponse,
  PublicSessionResponse,
  SessionDetailResponse,
} from "../src/shared/types.js";
import { createInMemoryDb } from "../src/server/db/index.js";
import { SettingsRepository } from "../src/server/settings/repository.js";
import { SessionRepository } from "../src/server/session/repository.js";
import * as avatarImage from "../apps/a-frontend/src/avatar-image";
import {
  toRevealInfo,
  toSessionSummary,
} from "../src/server/session/mapper.js";

// 形状闸只有一处实现（src/shared/avatars.ts），前后端与这里共用。
// 这些用例的意义不在"函数没写错"，而在于：任何不在白名单里的字符串，
// 都不可能被存进库、再随揭晓载荷发到对方浏览器里（那是 XSS 与体积两条同时的口子）。

const png = (bytes = 32) =>
  `data:image/png;base64,${"Qw5T0lHUwANaWxkcmVuTm90QVBJRA==".slice(0, 28).padEnd(bytes, "=")}`;

describe("sanitizeAvatarData（A 上传的身份头像）", () => {
  it("收三种位图的纯 base64 data URL", () => {
    for (const mime of ["png", "jpeg", "webp"])
      expect(
        sanitizeAvatarData(`data:image/${mime};base64,iVBORw0KGgo=`),
      ).toBe(`data:image/${mime};base64,iVBORw0KGgo=`);
  });

  it("svg / 带 charset / 普通网址 / 裸 base64 一律退回空串", () => {
    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "data:image/png;charset=utf8;base64,iVBORw0KGgo=",
      "https://evil.example/a.png",
      "iVBORw0KGgoAAAABSUhEUg==",
      "",
      "   ",
    ])
      expect(sanitizeAvatarData(bad)).toBe("");
  });

  it("非字符串（undefined / 数字 / 对象）不炸，退回空串", () => {
    for (const v of [undefined, null, 42, { data: png() }, ["x"]])
      expect(sanitizeAvatarData(v)).toBe("");
  });

  it("超出字符上限就整条不要（不截断，免得留半张图）", () => {
    const tooBig = `data:image/png;base64,${"A".repeat(MAX_AVATAR_DATA_CHARS)}`;
    expect(sanitizeAvatarData(tooBig)).toBe("");
    expect(
      sanitizeAvatarData(
        `data:image/png;base64,${"A".repeat(MAX_AVATAR_DATA_CHARS - 40)}`,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("base64 段里出现 URL 安全的其他字符（%、空格）也不收", () => {
    expect(sanitizeAvatarData("data:image/png;base64,iVB ORw0KG=")).toBe("");
    expect(sanitizeAvatarData("data:image/png;base64,iVB%20ORw=")).toBe("");
  });
});

describe("hasAvatarData（B 端选 <img> 还是选文字头像）", () => {
  it("空串 / 空白 / null / undefined 都算没传", () => {
    for (const v of ["", "  ", null, undefined])
      expect(hasAvatarData(v)).toBe(false);
    expect(hasAvatarData(png())).toBe(true);
  });
});

// ── 落库 / 快照 / 揭晓载荷这三段，是「头像会不会串到别人那轮对话上」的证据 ──────────

const AVATAR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

describe("身份头像的存储与快照", () => {
  let db: Database.Database;
  let settings: SettingsRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    settings = new SettingsRepository(db);
  });

  afterEach(() => db.close());

  it("存进去什么形状就取出来什么；不合法的形状当场变空串", () => {
    settings.save({
      ownerName: "张三",
      ownerAvatarId: "robot-04",
      ownerAvatarData: AVATAR,
      defaultRevealMessage: "被你发现啦",
    });
    expect(settings.get().ownerAvatarData).toBe(AVATAR);

    settings.save({
      ownerName: "张三",
      ownerAvatarId: "robot-04",
      ownerAvatarData: "data:image/svg+xml,<svg onload=alert(1)>",
      defaultRevealMessage: "被你发现啦",
    });
    expect(settings.get().ownerAvatarData).toBe("");
  });

  it("建会话时快照到会话行：之后 A 换头像、清空头像都不影响已发出去的链接", () => {
    settings.save({
      ownerName: "张三",
      ownerAvatarId: "robot-04",
      ownerAvatarData: AVATAR,
      defaultRevealMessage: "被你发现啦",
    });
    const sessions = new SessionRepository(db);
    const created = sessions.create(
      settings.snapshotForSession({
        aiName: "小雷 AI",
        avatarId: "robot-01",
        openingMessage: "你好",
      }),
    );

    settings.save({
      ownerName: "张三",
      ownerAvatarId: "robot-01",
      ownerAvatarData: "", // 当场清空
      defaultRevealMessage: "被你发现啦",
    });

    const row = sessions.requireById(created.id);
    expect(toSessionSummary(row).profile.ownerAvatarData).toBe(AVATAR);
    // 虚构 AI 的头像跟 A 的身份头像是两件事：前者不吃这张上传图。
    expect(toSessionSummary(row).profile.avatarId).toBe("robot-01");

    expect(toRevealInfo(sessions.reveal(created.id, "OWNER_ACTION"))).toMatchObject(
      { avatarId: "robot-04", avatarData: AVATAR },
    );
  });

  it("没上传时揭晓载荷给空串，B 端据此退回内置文字头像", () => {
    const sessions = new SessionRepository(db);
    const created = sessions.create(
      settings.snapshotForSession({
        aiName: "小雷 AI",
        avatarId: "robot-02",
        openingMessage: "你好",
      }),
    );
    const revealed = toRevealInfo(sessions.reveal(created.id, "ROUND_LIMIT"));
    expect(revealed?.avatarData).toBe("");
    expect(hasAvatarData(revealed?.avatarData)).toBe(false);
  });
});

// ── 前端两个纯函数：粘贴的两条来源 + 「别抢输入框」的判据 ─────────────────────────
// vitest 跑在 node 环境（没有 DOM），所以这里喂鸭子类型的假对象；
// 真·浏览器那一遍在 docs/dev-archive/browser-checks/verify-owner-avatar.mjs。

const fakeFile = { name: "a.png", type: "image/png" };

describe("imageFromClipboard（⌘V 的两条来源）", () => {
  const { imageFromClipboard } = avatarImage;

  it("finder 复制的图片文件走 files", () => {
    expect(imageFromClipboard({ files: [fakeFile], items: [] })).toBe(fakeFile);
  });

  it("微信 / 网页里复制的一张图，files 是空的，只能从 items 里捞", () => {
    const dt = {
      files: [],
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => fakeFile },
      ],
    };
    expect(imageFromClipboard(dt)).toBe(fakeFile);
  });

  it("剪贴板里只有文字 / 什么都没有 → null（不吭声也不拦）", () => {
    expect(
      imageFromClipboard({
        files: [],
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      }),
    ).toBeNull();
    expect(imageFromClipboard({ files: [], items: [] })).toBeNull();
    expect(imageFromClipboard(null)).toBeNull();
  });
});

describe("isTextEntryTarget（焦点在输入控件里时不许抢粘贴）", () => {
  const { isTextEntryTarget } = avatarImage;

  it("input / textarea / select / contenteditable 都算正在打字", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"])
      expect(isTextEntryTarget({ tagName: tag, isContentEditable: false })).toBe(true);
    expect(isTextEntryTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("普通 div / body / button / null / 空对象 都不算", () => {
    const notEditing = [
      { tagName: "DIV", isContentEditable: false },
      { tagName: "BODY", isContentEditable: false },
      { tagName: "BUTTON", isContentEditable: false },
      null,
      undefined,
      {},
    ];
    for (const el of notEditing) expect(isTextEntryTarget(el)).toBe(false);
  });
});

// ── 假 AI 的头像（2026-09-13）：一张打包进去的默认图 + 一个可上传替换的口子 ──────────
//
// 这一组用例管三件事：默认图真的在两个前端的产物里（漏一份就是 B 端破图）、
// 上传的图只跟着"这一条会话"走（快照，不串会话）、以及任何不合法的形状都到不了 B 的浏览器。

const AI_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

describe("假 AI 的默认头像文件", () => {
  // 放在 src/assets 而不是 public/：B 那个进程的静态白名单只认 /assets/*，
  // 根路径的图片会被 404（这条是被真浏览器探针抓出来才改的）。
  const rels = [
    "../apps/a-frontend/src/assets/ai-avatar.jpg",
    "../apps/b-frontend/src/assets/ai-avatar.jpg",
  ] as const;

  it("常量指的就是这个文件名（改了常量没改文件，B 端只有一个破图）", () => {
    expect(DEFAULT_AI_AVATAR_FILE).toBe("ai-avatar.jpg");
    for (const rel of rels) expect(rel.endsWith("/" + DEFAULT_AI_AVATAR_FILE)).toBe(true);
  });

  it("两个前端各一份，而且字节一模一样（不一致=有一边漏更新，公开面和私有面会长出两张脸）", () => {
    const bufs = rels.map(
      (rel) => new Uint8Array(readFileSync(new URL(rel, import.meta.url))),
    );
    expect(bufs[0].byteLength).toBeGreaterThan(1000);
    expect(Buffer.from(bufs[0]).equals(Buffer.from(bufs[1]))).toBe(true);
  });

  it("体积守在一个数以内：这张图每次冷访问都要下一遍，涨大了就是有人把原图丢了进来", () => {
    for (const rel of rels) {
      const bytes = readFileSync(new URL(rel, import.meta.url)).byteLength;
      // 现在是 16.9KB（2160×2160 的 3.8MB 原图压到 256px JPEG）。留 4 倍余量给以后换图。
      expect(bytes).toBeLessThan(60_000);
    }
  });
});

describe("假 AI 的上传头像：快照、读取与下发", () => {
  let db: Database.Database;
  let settings: SettingsRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    settings = new SettingsRepository(db);
  });

  afterEach(() => db.close());

  const createWith = (avatarData?: string) =>
    new SessionRepository(db).create(
      settings.snapshotForSession({
        aiName: "小雷 AI",
        avatarId: "robot-03",
        avatarData,
        openingMessage: "你好",
        revealMessage: "其实是我",
      }),
    );

  it("带合法图：A 的会话详情里原样取得回来", () => {
    const sessions = new SessionRepository(db);
    const id = createWith(AI_PNG).id;
    const profile = toSessionSummary(sessions.requireById(id)).profile;
    expect(profile.avatarData).toBe(AI_PNG);
    // A 的身份头像那条线不受影响：两张脸各有各的列。
    expect(profile.ownerAvatarData).toBe("");
  });

  it("svg / 超长 / 任意字符串：当场变空串，B 端据此退回默认图，不会把脏字符串送进对方 DOM", () => {
    const sessions = new SessionRepository(db);
    for (const bad of [
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
      "https://evil.example/x.png",
      "javascript:alert(1)",
      "data:image/png;base64," + "A".repeat(MAX_AVATAR_DATA_CHARS + 10),
    ]) {
      const id = createWith(bad).id;
      const profile = toSessionSummary(sessions.requireById(id)).profile;
      expect(profile.avatarData).toBe("");
      expect(hasAvatarData(profile.avatarData)).toBe(false);
    }
  });

  it("每条会话各带各的图，不串台", () => {
    const sessions = new SessionRepository(db);
    const a = createWith(AI_PNG).id;
    const b = createWith("").id;
    expect(toSessionSummary(sessions.requireById(a)).profile.avatarData).toBe(
      AI_PNG,
    );
    expect(toSessionSummary(sessions.requireById(b)).profile.avatarData).toBe("");
  });

  it("迁移前的老会话行里压根没这一列：读出来是空串，不炸也不白屏", () => {
    const sessions = new SessionRepository(db);
    const row = { ...sessions.requireById(createWith(AI_PNG).id) };
    delete row.ai_avatar_data;
    expect(toSessionSummary(row).profile.avatarData).toBe("");
  });
});

describe("假 AI 的头像走公开面（B 看得到的那两份载荷）", () => {
  const cookieOf = (res: Response, name: string) =>
    (res.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]+)`))?.[1] ??
    null;

  async function createViaHttp(body: unknown): Promise<string> {
    __resetBootstrapConsumedForTests();
    const localApp = createLocalApp();
    const boot = await localApp.request(`/api/local/bootstrap/${getControlToken()}`, {
      method: "POST",
      headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
    });
    const control = cookieOf(boot, CONTROL_COOKIE_NAME);
    const res = await localApp.request("/api/local/sessions", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
        cookie: `${CONTROL_COOKIE_NAME}=${control}`,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201); // 建会话是 201，不是 200
    return ((await res.json()) as CreateSessionResponse).session.id;
  }

  it("预览（还没绑定 B 时就能看）带 avatarData：那正是这张脸第一次露出来的时刻", async () => {
    const id = await createViaHttp({ aiName: "小雷 AI", avatarData: AI_PNG });
    const res = await createPublicApp().request(
      `/api/public/sessions/${id}/preview`,
    );
    const body = (await res.json()) as PreviewResponse;
    expect(body.avatarData).toBe(AI_PNG);
  });

  it("正式会话载荷带 avatarData；A 没上传时是空串（B 端退回默认图）", async () => {
    const withUpload = await createViaHttp({ aiName: "小雷 AI", avatarData: AI_PNG });
    const plain = await createViaHttp({ aiName: "小雷 AI" });
    const publicApp = createPublicApp();

    const claim = await publicApp.request(
      `/api/public/sessions/${withUpload}/claim`,
      { method: "POST", headers: { origin: "http://127.0.0.1:8788" } },
    );
    const claimCookie = cookieOf(claim, CLAIM_COOKIE_NAME);
    const detail = (await (
      await publicApp.request(`/api/public/sessions/${withUpload}`, {
        headers: { cookie: `${CLAIM_COOKIE_NAME}=${claimCookie}` },
      })
    ).json()) as PublicSessionResponse;
    expect(detail.avatarData).toBe(AI_PNG);

    const plainClaim = await publicApp.request(
      `/api/public/sessions/${plain}/claim`,
      { method: "POST", headers: { origin: "http://127.0.0.1:8788" } },
    );
    const plainDetail = (await (
      await publicApp.request(`/api/public/sessions/${plain}`, {
        headers: {
          cookie: `${CLAIM_COOKIE_NAME}=${cookieOf(plainClaim, CLAIM_COOKIE_NAME)}`,
        },
      })
    ).json()) as PublicSessionResponse;
    expect(plainDetail.avatarData).toBe("");
  });

  it("超大图在门口就被拒（不会先进库再靠读时兜底）", async () => {
    const id = await createViaHttp({ aiName: "小雷 AI" });
    expect(id).toBeTruthy();
    const localApp = createLocalApp();
    __resetBootstrapConsumedForTests();
    const boot = await localApp.request(`/api/local/bootstrap/${getControlToken()}`, {
      method: "POST",
      headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
    });
    const res = await localApp.request("/api/local/sessions", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
        cookie: `${CONTROL_COOKIE_NAME}=${cookieOf(boot, CONTROL_COOKIE_NAME)}`,
      },
      body: JSON.stringify({
        aiName: "小雷 AI",
        avatarData: "data:image/png;base64," + "A".repeat(MAX_AVATAR_DATA_CHARS + 1),
      }),
    });
    expect(res.status).toBe(400);
  });
});
