import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskCalendarQuerySchema,
  taskEventSchema,
  taskEventsQuerySchema,
  taskTimelineItemSchema,
  taskTimelineQuerySchema,
} from "./task-events.js";

const event = {
  id: "te_1", projectId: "p1", taskId: "t1", kind: "status",
  fromValue: "doing", toValue: "done", actor: { type: "agent", id: "ag_1" },
  at: "2026-09-25T12:00:00.000Z",
};

test("task event protocol is strict and has no free text fields", () => {
  assert.equal(taskEventSchema.safeParse(event).success, true);
  assert.equal(taskEventSchema.safeParse({ ...event, text: "secret" }).success, false);
  assert.equal(taskEventSchema.safeParse({ ...event, actor: { ...event.actor, email: "x" } }).success, false);
  assert.equal(taskEventSchema.safeParse({ ...event, toValue: "x".repeat(201) }).success, false);
});

test("task calendar and timeline windows require ordered ISO dates up to 93 days", () => {
  const valid = { from: "2026-01-01T00:00:00Z", to: "2026-04-04T00:00:00Z" };
  assert.equal(taskCalendarQuerySchema.safeParse(valid).success, true);
  assert.equal(taskTimelineQuerySchema.safeParse(valid).success, true);
  assert.equal(taskCalendarQuerySchema.safeParse({ from: valid.from, to: "2026-04-05T00:00:00Z" }).success, false);
  assert.equal(taskCalendarQuerySchema.safeParse({ ...valid, unexpected: "x" }).success, false);
});

test("event pagination is clamped by strict schema", () => {
  assert.deepEqual(taskEventsQuerySchema.parse({ limit: "100", offset: "10" }), { limit: 100, offset: 10 });
  assert.equal(taskEventsQuerySchema.safeParse({ limit: "501", offset: "0" }).success, false);
  assert.equal(taskEventsQuerySchema.safeParse({ limit: "10", offset: "0", text: "x" }).success, false);
});

test("timeline item carries a concrete end for open task interval", () => {
  const item = {
    id: "t1", taskNumber: 1, status: "doing", createdAt: "2026-09-01T00:00:00Z",
    closedAt: null, closedAtEstimated: false, assigneeAgentId: null,
    interval: { start: "2026-09-01T00:00:00Z", end: "2026-09-25T12:00:00Z" }, events: [event],
  };
  assert.equal(taskTimelineItemSchema.safeParse(item).success, true);
  assert.equal(taskTimelineItemSchema.safeParse({ ...item, interval: { ...item.interval, end: null } }).success, false);
});
