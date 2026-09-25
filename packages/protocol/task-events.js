import { z } from "zod";

const isoUtc = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(200);

export const taskEventActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id }).strict(),
  z.object({ type: z.literal("agent"), id }).strict(),
  z.object({ type: z.literal("system"), id }).strict(),
  z.object({ type: z.literal("integration"), id }).strict(),
]);

export const taskEventSchema = z.object({
  id,
  projectId: id,
  taskId: id,
  kind: z.enum(["created", "status", "assignee", "locked", "unlocked", "blocked", "unblocked", "comment", "reopened", "deleted"]),
  fromValue: z.string().max(200).nullable().optional(),
  toValue: z.string().max(200).nullable().optional(),
  actor: taskEventActorSchema,
  at: isoUtc,
}).strict();

const dateRange = (shape) => shape.strict().superRefine((range, ctx) => {
  const start = Date.parse(range.from);
  const end = Date.parse(range.to);
  if (end <= start) ctx.addIssue({ code: "custom", message: "to must be after from", path: ["to"] });
  if (end - start > 93 * 24 * 60 * 60 * 1000) ctx.addIssue({ code: "custom", message: "range cannot exceed 93 days", path: ["to"] });
});
const rangeShape = z.object({ from: isoUtc, to: isoUtc });
export const taskCalendarQuerySchema = dateRange(rangeShape);
export const taskEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
export const taskTimelineQuerySchema = dateRange(rangeShape.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}));

export const taskCalendarItemSchema = z.object({
  id,
  taskNumber: z.number().int().nullable(),
  status: z.enum(["todo", "doing", "done", "blocked"]),
  createdAt: isoUtc,
  closedAt: isoUtc.nullable(),
  closedAtEstimated: z.boolean(),
  assigneeAgentId: id.nullable(),
}).strict();

export const taskTimelineItemSchema = taskCalendarItemSchema.extend({
  interval: z.object({ start: isoUtc, end: isoUtc }).strict(),
  events: z.array(taskEventSchema),
}).strict();
