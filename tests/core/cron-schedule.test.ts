import assert from "node:assert/strict";
import test from "node:test";

import { nextCronOccurrence, parseCronSchedule } from "../../dist/cron-schedule.js";

test("UTC cron occurrences advance strictly after the reference instant", () => {
  assert.equal(nextCronOccurrence("*/15 * * * *", new Date("2026-09-25T11:14:59Z")).toISOString(), "2026-09-25T11:15:00.000Z");
  assert.equal(nextCronOccurrence("*/15 * * * *", new Date("2026-09-25T11:15:00Z")).toISOString(), "2026-09-25T11:30:00.000Z");
  assert.equal(nextCronOccurrence("0 0 1 1 *", new Date("2026-09-25T00:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(nextCronOccurrence("0 0 29 2 *", new Date("2025-03-01T00:00:00Z")).toISOString(), "2028-02-29T00:00:00.000Z");
});

test("day-of-month and weekday follow standard cron OR semantics unless either is unrestricted", () => {
  assert.equal(nextCronOccurrence("0 9 1 * 1", new Date("2026-09-25T00:00:00Z")).toISOString(), "2026-09-28T09:00:00.000Z");
  assert.equal(nextCronOccurrence("0 9 * * 1", new Date("2026-09-28T09:00:00Z")).toISOString(), "2026-10-05T09:00:00.000Z");
  assert.equal(nextCronOccurrence("0 9 1 * *", new Date("2026-09-25T00:00:00Z")).toISOString(), "2026-10-01T09:00:00.000Z");
});

test("cron parser fails closed for malformed, unbounded or impossible expressions", () => {
  for (const expression of ["* * * *", "* * * * * *", "@daily", "*/0 * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 7", "0/2 * * * *", "1-0 * * * *", "* * * * *;rm"]) {
    assert.throws(() => parseCronSchedule(expression), /cron/i, expression);
  }
  assert.throws(() => nextCronOccurrence("0 0 31 2 *", new Date("2026-01-01T00:00:00Z")), /no occurrence/);
  assert.throws(() => nextCronOccurrence("* * * * *", new Date(NaN)), /reference time/);
});
