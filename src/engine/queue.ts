/**
 * Plain FIFO queue logic for runIds, kept as pure array operations with no process or
 * timer involved — testable without spawning anything. The server wraps this with the
 * actual concurrency state (which run is currently active), but the ordering/position
 * math itself lives here so it can be tested in isolation.
 */

/**
 * How many runs are ahead of `runId` in the queue — this is the number the spec's
 * `{ status: "queued", ahead: N }` SSE event reports. Returns -1 if `runId` isn't in the
 * queue at all (caller's responsibility to only call this for a runId it just enqueued,
 * or to treat -1 as "not queued" rather than a valid position).
 */
export function positionInQueue(queue: string[], runId: string): number {
  const index = queue.indexOf(runId);
  return index; // 0-indexed "ahead" count naturally: index 0 means 0 runs ahead of it
}

/**
 * Adds a runId to the back of the queue. Returns a new array — never mutates the input,
 * same immutability discipline as formLogic.ts's reset/restore functions.
 */
export function enqueueRun(queue: string[], runId: string): string[] {
  return [...queue, runId];
}

/**
 * Removes a runId from anywhere in the queue (used both for normal dequeue-to-run and for
 * the "remove-from-queue" cancel branch from decideCancelAction — a cancelled queued run
 * needs to disappear from the middle of the queue just as cleanly as the front).
 */
export function removeFromQueue(queue: string[], runId: string): string[] {
  return queue.filter((id) => id !== runId);
}

/**
 * The next run to become active, and the remaining queue after removing it. Returns null
 * for `next` if the queue is empty — the caller (server) is responsible for deciding what
 * "nothing to run" means (e.g. going idle), not this function.
 */
export function dequeueNext(queue: string[]): { next: string | null; remaining: string[] } {
  if (queue.length === 0) return { next: null, remaining: [] };
  const [next, ...remaining] = queue;
  return { next, remaining };
}
