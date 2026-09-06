import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, InvalidRunRequestError } from "./Runmanager";
import type { ToolSchema } from "./buildArgsArray";

// A trivial, always-available "tool" schema — NOT ffmpeg, and NOT a raw shell (sh/cmd
// behave too differently across platforms to use reliably here: bare `cmd result.txt`
// with no /c doesn't execute and exit on Windows, it starts an interactive session and
// hangs forever — a real bug this fix closes). Node itself is spawned directly (no shell
// involved either way, matching spawn's own no-shell contract), which behaves identically
// on Windows and POSIX: `node -e "code" arg` puts `arg` at process.argv[1] on both.
const NODE = process.execPath;

const echoSchema: ToolSchema = {
    binary: NODE,
    flags: [
        {
            flag: "-e",
            kind: "standard",
            type: "string",
            default: "process.exit(0);",
        },
        { flag: "output", kind: "positional", type: "string", required: true },
    ],
};

let tmpDir: string;
let outputDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cliface-test-tmp-"));
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "cliface-test-output-"));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
});

describe("RunManager — real subprocess integration", () => {
    it("spawns a real process, receives a completion event, and moves the output file", async () => {
        // node -e writes to process.argv[1] (the substituted tmp path), standing in for
        // "ffmpeg writes an output file" without depending on ffmpeg being installed, and
        // without any of sh/cmd's platform-specific argv-passing differences.
        // A real script file on disk, not `node -e`: Node continues parsing dash-prefixed
        // tokens as ITS OWN CLI flags after -e's value ends — which is exactly what
        // "-progress" collided with above (insertProgressFlag runs unconditionally on every
        // schema, including this fake one, and has no way to know this isn't ffmpeg). Once
        // Node sees an actual script FILE argument, it stops parsing anything after it as its
        // own flags — everything becomes plain process.argv for the script, sidestepping the
        // collision entirely. The script path itself is a second positional field, kept
        // separate from "output" so RunManager's tmp-path substitution (which only overwrites
        // the field literally named "output") never touches it.
        const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "cliface-test-scripts-"));
        const scriptPath = path.join(scriptDir, "write-test-file.cjs");
        fs.writeFileSync(
            scriptPath,
            "const a=process.argv;require('fs').writeFileSync(a[a.length-1],'test output');"
        );

        const writeFileSchema: ToolSchema = {
            binary: NODE,
            flags: [
                { flag: "scriptPath", kind: "positional", type: "string", required: true },
                { flag: "output", kind: "positional", type: "string", required: true },
            ],
        };

        const manager = new RunManager(tmpDir, outputDir);

        const eventPromise = new Promise<{ type: string;[key: string]: unknown }>((resolve) => {
            const check = (event: any) => {
                if (event.type === "completed" || event.type === "error") {
                    resolve(event);
                }
            };
            const runId = manager.submitRun("echo-tool", writeFileSchema, {
                scriptPath,
                output: "result.txt",
            });
            manager.subscribe(runId, check);
        });

        const finalEvent = await eventPromise;

        // Now that the schema genuinely writes a file (via node -e, no shell involved), this
        // must succeed for real — "completed or error" was only an acceptable outcome when
        // the old sh/cmd schema couldn't actually produce a file at all.
        expect(finalEvent.type).toBe("completed");
        const finalPath = (finalEvent as any).outputPath as string;
        expect(fs.existsSync(finalPath)).toBe(true);
        expect(fs.readFileSync(finalPath, "utf-8")).toBe("test output");

        // The tmp file must not be left behind after a successful move to outputDir.
        const tmpContents = fs.readdirSync(tmpDir);
        expect(tmpContents.length).toBe(0);

        fs.rmSync(scriptDir, { recursive: true, force: true });
    });

    it("queued run reports position via a queued event, then starts once the active run finishes", async () => {
        const manager = new RunManager(tmpDir, outputDir);
        const events: Record<string, RunEventLog[]> = {};

        function track(runId: string) {
            events[runId] = [];
            manager.subscribe(runId, (event) => events[runId].push(event));
        }

        const runId1 = manager.submitRun("echo-tool", echoSchema, { output: "a.txt" });
        track(runId1);
        const runId2 = manager.submitRun("echo-tool", echoSchema, { output: "b.txt" });
        track(runId2);

        // Give both processes a moment to run to completion.
        await new Promise((r) => setTimeout(r, 500));

        // run2 should have seen a "queued" event at some point, since run1 was active first.
        const run2Types = events[runId2].map((e) => e.type);
        expect(run2Types).toContain("queued");
    });

    it("cancelling a queued run removes it without ever touching the active process, and eventually cleans up lastEventByRun after the grace window", async () => {
        // Short retention (50ms) so this test doesn't need to wait 30 real seconds.
        const manager = new RunManager(tmpDir, outputDir, 50);
        const events: RunEventLog[] = [];

        // Submit a long-running-ish active run, then a second one that will queue behind it.
        const activeRunId = manager.submitRun("echo-tool", echoSchema, { output: "active.txt" });
        const queuedRunId = manager.submitRun("echo-tool", echoSchema, { output: "queued.txt" });
        manager.subscribe(queuedRunId, (e) => events.push(e));

        manager.cancelRun(queuedRunId);

        expect(events.some((e) => e.type === "cancelled")).toBe(true);

        // Updated for the corrected grace-window model: immediately after cancellation, the
        // entry is DELIBERATELY still present (a late-connecting client needs to see it) —
        // it's only cleaned up after terminalEventRetentionMs elapses, not instantly.
        const leakedMap = (manager as any).lastEventByRun as Map<string, unknown>;
        expect(leakedMap.has(queuedRunId)).toBe(true);

        await new Promise((r) => setTimeout(r, 100));
        expect(leakedMap.has(queuedRunId)).toBe(false);
    });

    it("lastEventByRun retains an entry through the grace window after a terminal state, then cleans up (fixes the fast-run 404 race)", async () => {
        const manager = new RunManager(tmpDir, outputDir, 50);

        const runId = manager.submitRun("echo-tool", echoSchema, { output: "result.txt" });

        await new Promise<void>((resolve) => {
            manager.subscribe(runId, (event) => {
                if (event.type === "completed" || event.type === "error") resolve();
            });
        });

        // Immediately after completion: still retained, still replayable — this is exactly
        // what a client connecting slightly late to a fast-finishing run depends on.
        const leakedMap = (manager as any).lastEventByRun as Map<string, unknown>;
        expect(leakedMap.has(runId)).toBe(true);

        await new Promise((r) => setTimeout(r, 100));
        expect(leakedMap.has(runId)).toBe(false);
    });

    it("regression: submitRun rejects a request missing required 'output' BEFORE spawning anything, instead of silently defaulting to a fake filename", () => {
        const manager = new RunManager(tmpDir, outputDir);

        expect(() => manager.submitRun("echo-tool", echoSchema, {})).toThrow(
            InvalidRunRequestError
        );

        // The real proof: no process was ever spawned as a side effect of the rejected call.
        expect((manager as any).activeProcess).toBe(null);
        expect((manager as any).activeRunId).toBe(null);
    });

    it("a valid request with output present still submits and runs normally (no regression from the new validation)", () => {
        const manager = new RunManager(tmpDir, outputDir);

        const runId = manager.submitRun("echo-tool", echoSchema, { output: "ok.txt" });
        expect(typeof runId).toBe("string");
        expect((manager as any).activeRunId).toBe(runId);
    });

    it("hasRecordOf: true for an active run, true for a queued run, false for an unknown id", () => {
        const manager = new RunManager(tmpDir, outputDir);
        const activeId = manager.submitRun("echo-tool", echoSchema, { output: "a.txt" });
        const queuedId = manager.submitRun("echo-tool", echoSchema, { output: "b.txt" });

        expect(manager.hasRecordOf(activeId)).toBe(true);
        expect(manager.hasRecordOf(queuedId)).toBe(true);
        expect(manager.hasRecordOf("totally-unknown-id")).toBe(false);
    });

    it("regression: hasRecordOf stays true for a short grace window after a run completes, then eventually becomes false (fixes the fast-run race)", async () => {
        // Short retention window (50ms) so this test doesn't need to wait 30 real seconds.
        const manager = new RunManager(tmpDir, outputDir, 50);
        const runId = manager.submitRun("echo-tool", echoSchema, { output: "result.txt" });

        await new Promise<void>((resolve) => {
            manager.subscribe(runId, (event) => {
                if (event.type === "completed" || event.type === "error") resolve();
            });
        });

        // Immediately after completion: still within the grace window, still replayable —
        // this is the exact scenario a late-connecting client for a fast run depends on.
        expect(manager.hasRecordOf(runId)).toBe(true);

        // After the grace window elapses, memory is eventually reclaimed.
        await new Promise((r) => setTimeout(r, 100));
        expect(manager.hasRecordOf(runId)).toBe(false);
    });

    it("regression: a spawn failure (binary not found, e.g. ffmpeg missing from PATH) emits an error event instead of crashing as an uncaught exception", async () => {
        // Deliberately nonexistent binary name — reproduces ENOENT reliably on any machine,
        // regardless of whether ffmpeg (or anything else) happens to be installed. This is
        // exactly the failure mode a real user hits if ffmpeg isn't on their PATH: spawn()
        // itself fails, Node emits 'error' on the ChildProcess, and with no listener that
        // becomes an UNCAUGHT EXCEPTION that crashes the process rather than a normal error
        // event flowing through RunManager's usual event pipeline.
        const nonexistentBinarySchema: ToolSchema = {
            binary: "definitely-not-a-real-binary-xyz123",
            flags: [{ flag: "output", kind: "positional", type: "string", required: true }],
        };

        const manager = new RunManager(tmpDir, outputDir);
        const runId = manager.submitRun("echo-tool", nonexistentBinarySchema, {
            output: "result.txt",
        });

        const finalEvent = await new Promise<{ type: string;[key: string]: unknown }>(
            (resolve) => {
                manager.subscribe(runId, (event) => {
                    if (event.type === "completed" || event.type === "error") resolve(event);
                });
            }
        );

        expect(finalEvent.type).toBe("error");
        expect((finalEvent as any).message).toMatch(/Failed to start process/);

        // The queue must still be able to advance afterward — a spawn failure shouldn't
        // leave RunManager stuck thinking a run is still active.
        expect((manager as any).activeRunId).toBe(null);
    });
});

type RunEventLog = { type: string;[key: string]: unknown };