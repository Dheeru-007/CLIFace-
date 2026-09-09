import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import { buildTmpPath } from "./buildTmpPath";
import { insertProgressFlag } from "./insertProgressFlag";
import { decideCancelAction } from "./decideCancelAction";
import { enqueueRun, positionInQueue, removeFromQueue, dequeueNext } from "./queue";
import { buildArgsArray, type ToolSchema, type FormValues } from "./buildArgsArray";
import { canBuildArgs, hasActiveConflicts } from "./Formlogic";
import { formatHistoryEntry, appendHistoryEntry } from "./Runhistory";

const SIGINT_TO_SIGKILL_TIMEOUT_MS = 5000;

/**
 * Thrown by submitRun when the server's own independent validation (canBuildArgs,
 * hasActiveConflicts) fails against the raw client-supplied formValues — BEFORE any tmp
 * path is generated, any field is defaulted, or anything is queued. The server never
 * assumes the client already validated: POST /api/run is a plain HTTP endpoint any client
 * can hit directly, bypassing React's canBuildArgs-gated Run button entirely. The (not yet
 * written) Express layer catches this and responds 400 — RunManager itself stays free of
 * HTTP concerns, consistent with its existing design.
 */
export class InvalidRunRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidRunRequestError";
    }
}

export interface RunEvent {
    type: "queued" | "started" | "progress" | "completed" | "cancelled" | "error";
    [key: string]: unknown;
}

interface PendingRun {
    runId: string;
    toolId: string;
    schema: ToolSchema;
    formValues: FormValues;
    originalOutputFilename: string;
}

/**
 * Owns all run state: the queue, the single active process, and event emission. Kept as
 * a plain class with no Express dependency at all — every method here is callable and
 * testable without an HTTP server, per the spec's requirement that the decision logic be
 * extracted into small testable units rather than living inline in route handlers.
 */
export class RunManager extends EventEmitter {
    private queue: string[] = [];
    private pendingRuns = new Map<string, PendingRun>();
    private activeRunId: string | null = null;
    private activeProcess: ChildProcess | null = null;
    private sigkillTimer: NodeJS.Timeout | null = null;
    private tmpDir: string;
    private outputDir: string;
    // Last event emitted per run, so a client that subscribes AFTER an event already fired
    // — the realistic case, since a real client can't open the SSE connection until it has
    // the runId from POST /api/run's response, and submitRun may emit "queued" or even
    // "started" before that response is even sent — still gets caught up on the current
    // state instead of silently missing it.
    private lastEventByRun = new Map<string, RunEvent>();
    private terminalEventRetentionMs: number;
    private historyFilePath: string;

    /**
     * `terminalEventRetentionMs` is how long a terminal event (completed/error/cancelled)
     * stays replayable after firing — NOT immediate deletion. A client that connects
     * slightly late to a fast-finishing run (a realistic race: "browser finishes the POST,
     * then opens the EventSource" vs. "ffmpeg finishes converting a 2-second clip") still
     * needs to learn what happened, not just get a 404. This bounds memory the same way
     * immediate deletion did, just with a grace window instead of zero window. Configurable
     * (not hardcoded) so tests can use a short value instead of waiting 30 real seconds.
     */
    constructor(
        tmpDir: string,
        outputDir: string,
        terminalEventRetentionMs = 30_000,
        historyFilePath?: string
    ) {
        super();
        this.tmpDir = tmpDir;
        this.outputDir = outputDir;
        this.terminalEventRetentionMs = terminalEventRetentionMs;
        this.historyFilePath = historyFilePath ?? path.join(outputDir, "..", "history.json");
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(outputDir, { recursive: true });
    }

    /**
     * Whether RunManager has ever heard of this runId and could still possibly produce or
     * replay an event for it — active, queued, or within the terminal-event grace window.
     * The server's SSE handler checks this BEFORE opening a stream, so a request for a
     * runId that could never receive data gets an immediate 404 instead of a connection
     * that hangs forever with headers queued but never flushed.
     */
    hasRecordOf(runId: string): boolean {
        return (
            this.activeRunId === runId ||
            this.queue.includes(runId) ||
            this.lastEventByRun.has(runId)
        );
    }

    /**
     * The correct way to listen for a run's events — NOT manager.on(`run:${id}`, ...)
     * directly. Immediately replays the last known event (if any) synchronously before
     * attaching the live listener, so a subscriber that connects late never misses the
     * current state. Returns an unsubscribe function.
     */
    subscribe(runId: string, callback: (event: RunEvent) => void): () => void {
        const last = this.lastEventByRun.get(runId);
        if (last) callback(last);
        const listener = (event: RunEvent) => callback(event);
        this.on(`run:${runId}`, listener);
        return () => this.off(`run:${runId}`, listener);
    }

    /**
     * Registers a new run. Either starts it immediately or queues it. Returns the runId.
     * Throws InvalidRunRequestError if the raw formValues fail server-side validation —
     * checked BEFORE anything else happens, including computing originalOutputFilename,
     * so a missing required field can never be silently patched over by a convenience
     * default before buildArgsArray gets a chance to see the real (invalid) state.
     */
    submitRun(toolId: string, schema: ToolSchema, formValues: FormValues): string {
        if (!canBuildArgs(schema, formValues) || hasActiveConflicts(schema, formValues)) {
            throw new InvalidRunRequestError(
                "formValues failed server-side validation (a required field is missing, or two " +
                "conflicting flags are both active). The server never trusts that the client's " +
                "own canBuildArgs/hasActiveConflicts checks already ran — POST /api/run is a " +
                "plain HTTP endpoint any client can call directly, bypassing the React form " +
                "entirely."
            );
        }

        const runId = randomUUID();
        // Safe to read directly, no fallback: canBuildArgs above already confirmed `output`
        // (required: true in the ffmpeg schema) resolves to a real, non-empty value. A silent
        // fallback here (e.g. defaulting to the literal string "output") would have let a
        // missing-output request sail through — this was the actual bug: buildArgsArray was
        // never given the chance to see the real, invalid state, because a fake filename was
        // patched in before it ever ran.
        //
        // v1 assumption, stated explicitly: this reads the "output" key by name, since the
        // ffmpeg schema's single positional/required field happens to use that name — this
        // doesn't generalize to a future tool whose required output field is named
        // differently, same category of simplification as insertProgressFlag's single-
        // positional assumption.
        const originalOutputFilename = String(formValues["output"]);
        this.pendingRuns.set(runId, { runId, toolId, schema, formValues, originalOutputFilename });

        if (this.activeRunId === null) {
            this.startRun(runId);
        } else {
            this.queue = enqueueRun(this.queue, runId);
            this.emitEvent(runId, { type: "queued", ahead: positionInQueue(this.queue, runId) });
        }
        return runId;
    }

    /** Implements the two-branch cancel dispatch from decideCancelAction. */
    cancelRun(runId: string): void {
        const action = decideCancelAction(this.queue, this.activeRunId, runId);

        if (action.type === "remove-from-queue") {
            this.queue = removeFromQueue(this.queue, runId);
            this.pendingRuns.delete(runId);
            this.emitEvent(runId, { type: "cancelled" });
            this.scheduleLastEventCleanup(runId);
            return;
        }

        if (action.type === "signal-process" && this.activeProcess) {
            this.activeProcess.kill("SIGINT");
            this.sigkillTimer = setTimeout(() => {
                this.activeProcess?.kill("SIGKILL");
            }, SIGINT_TO_SIGKILL_TIMEOUT_MS);
            return;
        }

        // action.type === "not-found" — nothing to do; runId doesn't correspond to any
        // live or queued run (already finished, or never existed).
    }

    private startRun(runId: string): void {
        const pending = this.pendingRuns.get(runId);
        if (!pending) return;

        this.activeRunId = runId;
        this.emitEvent(runId, { type: "started" });

        const tmpOutputPath = buildTmpPath(pending.originalOutputFilename, this.tmpDir);
        const clonedFormValues = { ...pending.formValues, output: tmpOutputPath };

        let args: string[];
        try {
            args = buildArgsArray(pending.schema, clonedFormValues);
        } catch (err) {
            this.emitEvent(runId, { type: "error", message: String(err) });
            this.logHistory(pending.toolId, pending.formValues, "error", null);
            this.finishAndAdvance();
            return;
        }
        const argsWithProgress = insertProgressFlag(args);

        const child = spawn(pending.schema.binary, argsWithProgress);
        this.activeProcess = child;

        child.stdout.on("data", (chunk: Buffer) => {
            const progress = parseProgressLines(chunk.toString());
            if (progress) this.emitEvent(runId, { type: "progress", ...progress });
        });

        // Node's ChildProcess treats 'error' as a special EventEmitter event: with NO
        // listener attached, an emitted 'error' becomes an UNCAUGHT EXCEPTION that crashes
        // the process — this is exactly what happened when spawn() itself fails to launch
        // (e.g. ENOENT, binary not found/not on PATH). Whether 'close' ALSO fires alongside
        // 'error' for a given failure is platform/Node-version-dependent (the same category
        // of cross-platform subprocess quirk this project has hit before), so a `settled`
        // guard shared between both handlers prevents double-processing regardless of which
        // combination actually fires on a given machine.
        let settled = false;

        child.on("error", (err) => {
            if (settled) return;
            settled = true;

            if (this.sigkillTimer) {
                clearTimeout(this.sigkillTimer);
                this.sigkillTimer = null;
            }

            // The process never started, so there's nothing to clean up on disk beyond the
            // tmp path possibly existing from a partial attempt — best-effort removal, not
            // treated as a second failure if it doesn't exist.
            fs.rm(tmpOutputPath, { force: true }, () => { });
            this.emitEvent(runId, {
                type: "error",
                message: `Failed to start process: ${err.message}`,
            });
            this.logHistory(pending.toolId, pending.formValues, "error", null);

            this.pendingRuns.delete(runId);
            this.scheduleLastEventCleanup(runId);
            this.finishAndAdvance();
        });

        child.on("close", (code) => {
            if (settled) return;
            settled = true;

            if (this.sigkillTimer) {
                clearTimeout(this.sigkillTimer);
                this.sigkillTimer = null;
            }

            if (code === 0) {
                const finalPath = path.join(this.outputDir, pending.originalOutputFilename);
                try {
                    fs.renameSync(tmpOutputPath, finalPath);
                    this.emitEvent(runId, { type: "completed", outputPath: finalPath });
                    this.logHistory(pending.toolId, pending.formValues, "completed", finalPath);
                } catch (err) {
                    this.emitEvent(runId, { type: "error", message: String(err) });
                    this.logHistory(pending.toolId, pending.formValues, "error", null);
                }
            } else {
                // Non-zero exit (includes the SIGINT/SIGKILL cancel path) — clean up the partial
                // tmp file rather than leaving it behind.
                fs.rm(tmpOutputPath, { force: true }, () => { });
                this.emitEvent(runId, code === null ? { type: "cancelled" } : {
                    type: "error",
                    message: `Process exited with code ${code}`,
                });
                this.logHistory(
                    pending.toolId,
                    pending.formValues,
                    code === null ? "cancelled" : "error",
                    null
                );
            }

            this.pendingRuns.delete(runId);
            // CORRECTED from an earlier version that deleted immediately: that assumed the
            // client was always already connected by the time a terminal event fires, which is
            // false for a fast-finishing run — "browser finishes POST, then opens EventSource"
            // can lose the race against "ffmpeg finishes converting a 2-second clip." Immediate
            // deletion meant that client's GET /api/run/:id/events request would find nothing
            // in hasRecordOf and get a 404, silently telling the user nothing about whether
            // their run succeeded. A grace window fixes the race while still bounding memory.
            this.scheduleLastEventCleanup(runId);
            this.finishAndAdvance();
        });
    }

    private finishAndAdvance(): void {
        this.activeRunId = null;
        this.activeProcess = null;
        const { next, remaining } = dequeueNext(this.queue);
        this.queue = remaining;
        if (next) this.startRun(next);
    }

    private logHistory(
        toolId: string,
        formValues: FormValues,
        status: "completed" | "error" | "cancelled",
        outputPath: string | null
    ): void {
        try {
            appendHistoryEntry(this.historyFilePath, formatHistoryEntry(toolId, formValues, status, outputPath));
        } catch {
            // History logging is best-effort — a disk/permissions issue writing history must
            // never take down a run that otherwise succeeded or failed normally.
        }
    }

    private scheduleLastEventCleanup(runId: string): void {
        setTimeout(() => {
            this.lastEventByRun.delete(runId);
        }, this.terminalEventRetentionMs);
    }

    private emitEvent(runId: string, event: RunEvent): void {
        this.lastEventByRun.set(runId, event);
        this.emit(`run:${runId}`, event);
    }
}

/**
 * Parses -progress pipe:1's key=value stdout lines into a plain object. Returns null if
 * the chunk doesn't look like progress output (e.g. partial/empty reads).
 */
function parseProgressLines(chunk: string): Record<string, string> | null {
    const lines = chunk.split("\n").filter((l) => l.includes("="));
    if (lines.length === 0) return null;
    const result: Record<string, string> = {};
    for (const line of lines) {
        const [key, value] = line.split("=");
        if (key && value !== undefined) result[key.trim()] = value.trim();
    }
    return Object.keys(result).length > 0 ? result : null;
}