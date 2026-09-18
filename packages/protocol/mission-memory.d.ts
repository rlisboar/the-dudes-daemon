/** T-594: interpolação de `{{mem.NAME}}` (mission scratch) — ver mission-memory.js. */
export declare const MEM_PLACEHOLDER_SOURCE: string;
export declare function hasMemPlaceholder(text: string): boolean;
export declare function interpolateMissionMemory(text: string, mem?: Record<string, string> | null): string;