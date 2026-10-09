import { expect, test } from "vitest";
import { IDEMPOTENCY_WINDOW_MS, replayAllowed } from "../../src/operations.js";

test("permits a first attempt and conservative same-key retries, never a replay after provider retention", () => {
  const now = Date.now();
  expect(replayAllowed(null, now)).toBe(true);
  expect(replayAllowed(new Date(now - 1000), now)).toBe(true);
  expect(replayAllowed(new Date(now - IDEMPOTENCY_WINDOW_MS), now)).toBe(false);
  expect(replayAllowed(new Date(now - IDEMPOTENCY_WINDOW_MS + 30_000), now)).toBe(false);
});
