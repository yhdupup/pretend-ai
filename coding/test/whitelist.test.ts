import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { publicWhitelist } from "../src/server/middleware/whitelist.js";

function buildApp(): Hono {
  const app = new Hono();
  app.use("*", publicWhitelist);
  app.get("/api/public/sessions/:id", (c) => c.json({ ok: true }));
  app.get("/api/public", (c) => c.json({ ok: true }));
  return app;
}

describe("publicWhitelist", () => {
  it("allows exact /api/public", async () => {
    const app = buildApp();
    const res = await app.request("/api/public");
    expect(res.status).toBe(200);
  });

  it("allows /api/public/* prefix", async () => {
    const app = buildApp();
    const res = await app.request("/api/public/sessions/abc");
    expect(res.status).toBe(200);
  });

  const rejectedPaths = [
    "/api/local/sessions",
    "/api/local/bootstrap/token123",
    "/api/config/whatever",
    "/.env",
    "/data/dev.sqlite",
    "/src/server/index.ts",
    "/package.json",
    "/debug/anything",
    "/a",
    "/admin",
    "/api/publicx", // 前缀相似但不是合法边界，必须拒绝
  ];

  for (const path of rejectedPaths) {
    it(`returns 404 for disallowed path: ${path}`, async () => {
      const app = buildApp();
      const res = await app.request(path);
      expect(res.status).toBe(404);
    });
  }

  it("returns the same 404 body/status for a truly nonexistent route as for a blocked one", async () => {
    const app = buildApp();
    const blocked = await app.request("/api/local/sessions");
    const nonexistent = await app.request("/this/route/does/not/exist/at/all");
    expect(blocked.status).toBe(nonexistent.status);
    const blockedBody = await blocked.text();
    const nonexistentBody = await nonexistent.text();
    expect(blockedBody).toBe(nonexistentBody);
  });
});
