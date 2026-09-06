import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildTmpPath } from "./buildTmpPath";
import { insertProgressFlag } from "./insertProgressFlag";
import { decideCancelAction } from "./decideCancelAction";
import { enqueueRun, positionInQueue, removeFromQueue, dequeueNext } from "./queue";

describe("buildTmpPath", () => {
    it("preserves a normal single extension", () => {
        const result = buildTmpPath("audio.mp3", "/tmp");
        expect(result.endsWith(".mp3")).toBe(true);
        // path.join normalizes separators per-OS (backslash on Windows, forward slash on
        // POSIX) — comparing via path.dirname/path.normalize instead of a hardcoded "/tmp/"
        // string keeps this correct on both, rather than assuming a POSIX-only path shape.
        expect(path.dirname(result)).toBe(path.normalize("/tmp"));
    });

    it("preserves only the LAST extension on a multi-dot filename", () => {
        const result = buildTmpPath("my.video.mp4", "/tmp");
        expect(result.endsWith(".mp4")).toBe(true);
        expect(result.endsWith(".video.mp4")).toBe(false);
    });

    it("produces no extension for a filename with none", () => {
        const result = buildTmpPath("output_no_ext", "/tmp");
        expect(result.includes(".")).toBe(false);
    });

    it("generates a different path on each call (UUID-based, no collisions)", () => {
        const a = buildTmpPath("audio.mp3", "/tmp");
        const b = buildTmpPath("audio.mp3", "/tmp");
        expect(a).not.toBe(b);
    });
});

describe("insertProgressFlag", () => {
    it("inserts before the trailing positional in the normal case", () => {
        const args = ["-crf", "28", "-preset", "medium", "compressed.mp4"];
        const result = insertProgressFlag(args);
        expect(result).toEqual([
            "-crf", "28", "-preset", "medium", "-progress", "pipe:1", "compressed.mp4",
        ]);
    });

    it("handles an array with only the positional element", () => {
        const args = ["compressed.mp4"];
        const result = insertProgressFlag(args);
        expect(result).toEqual(["-progress", "pipe:1", "compressed.mp4"]);
    });

    it("known limitation: empty array (zero-positional schema, degenerate case) falls back to plain append, not silently guessed at", () => {
        const result = insertProgressFlag([]);
        expect(result).toEqual(["-progress", "pipe:1"]);
    });

    it("KNOWN BUG, documented not fixed: a realistic zero-positional schema's args (ordinary flag-value pairs, no positional at all) gets CORRUPTED — this function has no way to distinguish a trailing flag value from a positional argument, so it silently splits a legitimate flag/value pair apart. This test asserts the current (wrong) behavior on purpose, so whoever generalizes this function for tool #2 has a concrete failing case to fix rather than rediscovering the corruption by shipping it.", () => {
        // A hypothetical zero-positional tool: -b:a's value "192k" has nothing to do with a
        // positional argument, but insertProgressFlag can't tell the difference and treats it
        // as one anyway, inserting -progress pipe:1 in between -b:a and its own value.
        const args = ["-i", "input.mp4", "-b:a", "192k"];
        const result = insertProgressFlag(args);
        // This IS the bug: -b:a gets separated from "192k". Documented, not silently accepted
        // as correct — see insertProgressFlag.ts's doc comment for the required fix before
        // this function is reused for any schema without a guaranteed trailing positional.
        expect(result).toEqual(["-i", "input.mp4", "-b:a", "-progress", "pipe:1", "192k"]);
    });
});

describe("decideCancelAction", () => {
    it("returns remove-from-queue for a run sitting in the queue", () => {
        const result = decideCancelAction(["run-2", "run-3"], "run-1", "run-3");
        expect(result).toEqual({ type: "remove-from-queue" });
    });

    it("returns signal-process for the currently active run", () => {
        const result = decideCancelAction(["run-2", "run-3"], "run-1", "run-1");
        expect(result).toEqual({ type: "signal-process" });
    });

    it("returns not-found for a runId that's neither queued nor active", () => {
        const result = decideCancelAction(["run-2", "run-3"], "run-1", "run-999");
        expect(result).toEqual({ type: "not-found" });
    });

    it("checks the queue first — a runId that's (incorrectly) in both queue and active still resolves to remove-from-queue, never falling through to signal", () => {
        // Shouldn't happen in real server state, but proves the dispatch ORDER is queue-first,
        // exactly as the spec requires, rather than relying on the two sets being disjoint.
        const result = decideCancelAction(["run-1"], "run-1", "run-1");
        expect(result).toEqual({ type: "remove-from-queue" });
    });
});

describe("queue.ts", () => {
    it("enqueueRun adds to the back without mutating the input", () => {
        const original = ["run-1"];
        const result = enqueueRun(original, "run-2");
        expect(result).toEqual(["run-1", "run-2"]);
        expect(original).toEqual(["run-1"]); // unmutated
    });

    it("positionInQueue reports 0-indexed position", () => {
        const queue = ["run-1", "run-2", "run-3"];
        expect(positionInQueue(queue, "run-1")).toBe(0);
        expect(positionInQueue(queue, "run-3")).toBe(2);
    });

    it("positionInQueue returns -1 for a runId not in the queue", () => {
        expect(positionInQueue(["run-1"], "run-999")).toBe(-1);
    });

    it("removeFromQueue removes from the middle without disturbing order (the cancel-a-queued-run scenario)", () => {
        const queue = ["run-1", "run-2", "run-3"];
        const result = removeFromQueue(queue, "run-2");
        expect(result).toEqual(["run-1", "run-3"]);
    });

    it("dequeueNext returns the front of the queue and the remainder", () => {
        const queue = ["run-1", "run-2", "run-3"];
        const result = dequeueNext(queue);
        expect(result).toEqual({ next: "run-1", remaining: ["run-2", "run-3"] });
    });

    it("dequeueNext returns null next for an empty queue", () => {
        const result = dequeueNext([]);
        expect(result).toEqual({ next: null, remaining: [] });
    });

    it("full round-trip: enqueue two, dequeue one, confirm remaining state", () => {
        let queue: string[] = [];
        queue = enqueueRun(queue, "run-1");
        queue = enqueueRun(queue, "run-2");
        const { next, remaining } = dequeueNext(queue);
        expect(next).toBe("run-1");
        expect(remaining).toEqual(["run-2"]);
    });
});