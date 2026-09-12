import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createInMemoryDb } from "../src/server/db/index.js";
import {
  IdempotencyConflictError,
  IdempotencyStore,
  hashContent,
} from "../src/server/session/idempotency.js";

describe("IdempotencyStore", () => {
  let db: Database.Database;
  let store: IdempotencyStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new IdempotencyStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("computes a fresh result on first use of a key", () => {
    let computeCalls = 0;
    const result = store.resolve("key-1", "session-1", "hello", () => {
      computeCalls += 1;
      return { echoed: "hello" };
    });
    expect(result).toEqual({ echoed: "hello" });
    expect(computeCalls).toBe(1);
  });

  it("returns the cached result on same key + same content, without recomputing", () => {
    let computeCalls = 0;
    const compute = () => {
      computeCalls += 1;
      return { echoed: "hello", callIndex: computeCalls };
    };

    const first = store.resolve("key-1", "session-1", "hello", compute);
    const second = store.resolve("key-1", "session-1", "hello", compute);

    expect(second).toEqual(first);
    expect(computeCalls).toBe(1);
  });

  it("throws IdempotencyConflictError on same key + different content", () => {
    store.resolve("key-1", "session-1", "hello", () => ({ echoed: "hello" }));

    expect(() =>
      store.resolve("key-1", "session-1", "goodbye", () => ({
        echoed: "goodbye",
      })),
    ).toThrow(IdempotencyConflictError);
  });

  it("treats different keys independently even with identical content", () => {
    const a = store.resolve("key-a", "session-1", "same body", () => ({
      id: "a",
    }));
    const b = store.resolve("key-b", "session-1", "same body", () => ({
      id: "b",
    }));
    expect(a).toEqual({ id: "a" });
    expect(b).toEqual({ id: "b" });
  });

  it("hashContent is deterministic for identical input and differs for different input", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });
});
