import type { z } from "zod";
import type { TaskCalendarItem, TaskEvent, TaskEventActor, TaskTimelineItem } from "./wire.js";

export declare const taskEventActorSchema: z.ZodType<TaskEventActor>;
export declare const taskEventSchema: z.ZodType<TaskEvent>;
export declare const taskCalendarQuerySchema: z.ZodType<{ from: string; to: string }>;
export declare const taskEventsQuerySchema: z.ZodType<{ limit: number; offset: number }>;
export declare const taskTimelineQuerySchema: z.ZodType<{ from: string; to: string; limit: number; offset: number }>;
export declare const taskCalendarItemSchema: z.ZodType<TaskCalendarItem>;
export declare const taskTimelineItemSchema: z.ZodType<TaskTimelineItem>;
