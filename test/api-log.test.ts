import { expect, test } from "bun:test";
import { formatApiFailure } from "../src/api-log.js";

test("formats a mirror issue path and message", () => {
  const line = formatApiFailure("PUT", "/api/mirror", 400, {
    error: "Invalid mirror.",
    issues: [{
      path: ["memories", 3, "schedule", "recurrence", "weekdays"],
      message: "weekdays are only valid for weekly recurrence.",
    }],
  });
  expect(line).toBe("api PUT /api/mirror 400 Invalid mirror. memories.3.schedule.recurrence.weekdays: weekdays are only valid for weekly recurrence.");
});

test("keeps an error without issues and caps the list at three", () => {
  expect(formatApiFailure("POST", "/api/commands/abc/result", 404, { error: "Command not found." }))
    .toBe("api POST /api/commands/abc/result 404 Command not found.");
  const issues = [0, 1, 2, 3].map((index) => ({ path: ["memories", index], message: `Issue ${index}` }));
  expect(formatApiFailure("PUT", "/api/mirror", 400, { error: "Invalid mirror.", issues }))
    .toBe("api PUT /api/mirror 400 Invalid mirror. memories.0: Issue 0 memories.1: Issue 1 memories.2: Issue 2");
});

test("drops empty messages and non-path values", () => {
  expect(formatApiFailure("GET", "/api/commands", 400, {
    error: "  limit must be a positive integer.  ",
    issues: [
      { path: ["", 1.5, true, Symbol("x")], message: "   " },
      { message: "Missing field" },
    ],
  })).toBe("api GET /api/commands 400 limit must be a positive integer. Missing field");
  expect(formatApiFailure("PUT", "/api/mirror", 400, {})).toBe("api PUT /api/mirror 400 Request failed.");
});
