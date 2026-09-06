export type CancelAction =
  | { type: "remove-from-queue" }
  | { type: "signal-process" }
  | { type: "not-found" };

/**
 * Decides which of the two fundamentally different cancel branches applies to a given
 * runId — this is pure dispatch logic, deliberately separated from any actual queue
 * mutation or process signaling so it can be tested without a real process or timer.
 *
 * Order matters: the queue is checked FIRST. A run either sits in the queue (no OS
 * process exists yet — cancelling it means removing it from the queue and emitting a
 * `cancelled` SSE event directly, no signal involved) or it's the single active run
 * (the real SIGINT-then-SIGKILL flow applies). Checking the queue first and returning
 * immediately on a match is what prevents ever falling through to signal-sending code for
 * a run that was never spawned — the exact failure mode (throwing on a nonexistent
 * process, or worse, accidentally signaling whatever run happens to be active) the spec
 * called out as the risk of not distinguishing these two cases.
 */
export function decideCancelAction(
  queuedRunIds: string[],
  activeRunId: string | null,
  runId: string
): CancelAction {
  if (queuedRunIds.includes(runId)) {
    return { type: "remove-from-queue" };
  }
  if (activeRunId === runId) {
    return { type: "signal-process" };
  }
  return { type: "not-found" };
}
