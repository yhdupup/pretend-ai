import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  assertValidPendingTransition,
  assertValidRevealTransition,
  assertValidSessionTransition,
} from "../src/server/session/state-machine.js";

describe("session state machine", () => {
  it("allows the documented forward transitions", () => {
    expect(() =>
      assertValidSessionTransition("STARTING", "WAITING"),
    ).not.toThrow();
    expect(() =>
      assertValidSessionTransition("STARTING", "EXPIRED"),
    ).not.toThrow();
    expect(() =>
      assertValidSessionTransition("WAITING", "ACTIVE"),
    ).not.toThrow();
    expect(() =>
      assertValidSessionTransition("WAITING", "CLOSING_GRACE"),
    ).not.toThrow();
    expect(() =>
      assertValidSessionTransition("WAITING", "EXPIRED"),
    ).not.toThrow();
    expect(() =>
      assertValidSessionTransition("ACTIVE", "CLOSING_GRACE"),
    ).not.toThrow();
    expect(() =>
      assertValidSessionTransition("ACTIVE", "EXPIRED"),
    ).not.toThrow();
    expect(() =>
      assertValidSessionTransition("CLOSING_GRACE", "CLOSED"),
    ).not.toThrow();
    expect(() =>
      assertValidSessionTransition("CLOSING_GRACE", "ACTIVE"),
    ).not.toThrow();
  });

  it("treats same-state transitions as a no-op", () => {
    expect(() =>
      assertValidSessionTransition("WAITING", "WAITING"),
    ).not.toThrow();
    expect(() =>
      assertValidSessionTransition("ACTIVE", "ACTIVE"),
    ).not.toThrow();
  });

  it("rejects transitions out of terminal states", () => {
    expect(() => assertValidSessionTransition("CLOSED", "ACTIVE")).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertValidSessionTransition("EXPIRED", "WAITING")).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects skipping states or moving backwards illegally", () => {
    expect(() => assertValidSessionTransition("STARTING", "ACTIVE")).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertValidSessionTransition("ACTIVE", "WAITING")).toThrow(
      InvalidTransitionError,
    );
    expect(() =>
      assertValidSessionTransition("CLOSED", "CLOSING_GRACE"),
    ).toThrow(InvalidTransitionError);
  });
});

describe("reveal state machine", () => {
  it("allows HIDDEN -> REVEALED", () => {
    expect(() =>
      assertValidRevealTransition("HIDDEN", "REVEALED"),
    ).not.toThrow();
  });

  it("rejects repeated reveal (REVEALED -> REVEALED), unlike the other machines", () => {
    // 与 session/pending 状态机不同：这里故意不特判 from === to，
    // 因为路由层依赖此处抛错来对重复揭示返回 409 ALREADY_REVEALED。
    expect(() => assertValidRevealTransition("REVEALED", "REVEALED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects HIDDEN -> HIDDEN (illegal even though it's a same-state transition)", () => {
    expect(() => assertValidRevealTransition("HIDDEN", "HIDDEN")).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects REVEALED -> HIDDEN (irreversible)", () => {
    expect(() => assertValidRevealTransition("REVEALED", "HIDDEN")).toThrow(
      InvalidTransitionError,
    );
  });
});

describe("pending message state machine", () => {
  it("allows the documented forward transitions", () => {
    expect(() =>
      assertValidPendingTransition("IDLE", "WAITING_A"),
    ).not.toThrow();
    expect(() =>
      assertValidPendingTransition("WAITING_A", "GENERATING"),
    ).not.toThrow();
    expect(() =>
      assertValidPendingTransition("WAITING_A", "READY"),
    ).not.toThrow();
    expect(() =>
      assertValidPendingTransition("WAITING_A", "DROPPED"),
    ).not.toThrow();
    expect(() =>
      assertValidPendingTransition("GENERATING", "READY"),
    ).not.toThrow();
    expect(() =>
      assertValidPendingTransition("GENERATING", "DROPPED"),
    ).not.toThrow();
    expect(() =>
      assertValidPendingTransition("READY", "SENDING"),
    ).not.toThrow();
    expect(() =>
      assertValidPendingTransition("READY", "DROPPED"),
    ).not.toThrow();
    expect(() =>
      assertValidPendingTransition("SENDING", "DELIVERED"),
    ).not.toThrow();
    expect(() =>
      assertValidPendingTransition("SENDING", "DROPPED"),
    ).not.toThrow();
  });

  it("treats same-state transitions as a no-op", () => {
    expect(() =>
      assertValidPendingTransition("WAITING_A", "WAITING_A"),
    ).not.toThrow();
  });

  it("rejects transitions out of terminal states", () => {
    expect(() => assertValidPendingTransition("DELIVERED", "IDLE")).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertValidPendingTransition("DROPPED", "IDLE")).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects illegal jumps", () => {
    expect(() => assertValidPendingTransition("IDLE", "READY")).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertValidPendingTransition("READY", "GENERATING")).toThrow(
      InvalidTransitionError,
    );
  });
});
