/** Capabilities the running daemon can enforce before an agent turn starts. */
export const DAEMON_CAPABILITIES = ["member-gate", "pause"] as const;

export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

/** Attach daemon-side gates to the existing hello without mutating its input. */
export function withDaemonCapabilities<T extends object>(hello: T): T & { capabilities: DaemonCapability[] } {
  return { ...hello, capabilities: [...DAEMON_CAPABILITIES] };
}
