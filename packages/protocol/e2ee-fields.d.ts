export declare const BOARD_TEXT_FIELDS: string[];
export declare const BOARD_STEP_FIELDS: string[];
export declare const BOARD_CHART_SERIES_FIELDS: string[];
export declare const BOARD_CHART_HAS_LABELS: boolean;
export declare const BOARD_ANNOTATION_FIELDS: string[];
export declare const MESSAGE_FIELDS: string[];
export declare const MEMORY_PLAIN_TO_CIPHER: Record<string, string>;
export declare const TASK_FIELDS: string[];
export declare const COMMENT_FIELDS: string[];
export declare const GOAL_FIELDS: string[];
export declare const SUMMARY_FIELDS: string[];
export declare const PLAN_FIELDS: string[];
export declare const PLAN_TASK_FIELDS: string[];
export declare const MISSION_FIELDS: string[];
export declare const MISSION_STEP_FIELDS: string[];
export declare const SCHEDULE_FIELDS: string[];

export declare const E2EE_TABLE: {
  readonly TASKS: "tasks";
  readonly TASK_COMMENTS: "task_comments";
  readonly GOALS: "goals";
  readonly MEMORIES: "memories";
  readonly MESSAGES: "messages";
  readonly BOARDS: "explanation_boards";
  readonly SUMMARIES: "tts_summaries";
  readonly PLANS: "plans";
  readonly PLAN_TASKS: "plan_tasks";
  readonly MISSIONS: "missions";
  readonly MISSION_STEPS: "mission_steps";
  readonly SCHEDULES: "schedules";
};

export declare const E2E_PREFIX: "e2e:";
export declare const E2E_V2_PREFIX: "e2e:v2:";
export declare const E2E_V1_REJECT_PREFIX: "e2e:v1:";

export declare const AAD_READ_FALLBACK: ReadonlyArray<Readonly<{
  destTable: string;
  destField: string;
  sourceTable: string;
  sourceField: string;
}>>;

export declare function aadV2(args: { projectId: string; table: string; field: string }): string;
/** Leitura: AAD de destino, depois no máx. UMA fonte canônica (T-083 startPlan). */
export declare function aadReadChain(args: { projectId: string; table: string; field: string }): string[];
export declare function isE2eV2(stored: string): boolean;
export declare function isE2eV1Rejected(stored: string): boolean;
export declare function isPlainCatalogText(v: unknown): boolean;
/** Campos do catálogo em claro num write (comando WS ou op do bridge). */
export declare function catalogPlainHits(kind: string, payload: unknown): string[];
