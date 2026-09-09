import express, { type Express } from "express";
import { RunManager, InvalidRunRequestError } from "../engine/Runmanager";
import { createSchemaLoader, UnknownToolError } from "./schemaloader";

/**
 * Creates the Express app. Takes tmpDir/outputDir/schemasDir as parameters (not
 * hardcoded) so tests can point this at throwaway temp directories instead of the real
 * ~/CLIFace paths — same testability principle used throughout this project.
 */
export function createServer(
    tmpDir: string,
    outputDir: string,
    schemasDir: string,
    historyFilePath?: string
): {
    app: Express;
    runManager: RunManager;
} {
    const app = express();
    app.use(express.json());

    const runManager = new RunManager(tmpDir, outputDir, 30_000, historyFilePath);
    const loadSchema = createSchemaLoader(schemasDir);

    app.post("/api/run", (req, res) => {
        const { toolId, formValues } = req.body ?? {};

        if (typeof toolId !== "string" || typeof formValues !== "object" || formValues === null) {
            res.status(400).json({ error: "Request body must be { toolId: string, formValues: object }." });
            return;
        }

        let schema;
        try {
            schema = loadSchema(toolId);
        } catch (err) {
            if (err instanceof UnknownToolError) {
                res.status(400).json({ error: err.message });
                return;
            }
            res.status(500).json({ error: "Failed to load tool schema." });
            return;
        }

        try {
            const runId = runManager.submitRun(toolId, schema, formValues);
            res.status(200).json({ runId });
        } catch (err) {
            if (err instanceof InvalidRunRequestError) {
                res.status(400).json({ error: err.message });
                return;
            }
            res.status(500).json({ error: "Failed to submit run." });
        }
    });

    app.get("/api/run/:id/events", (req, res) => {
        const runId = req.params.id;

        // Checked BEFORE writeHead: a runId RunManager has never heard of (typo, already
        // long gone, never existed) can never produce or replay an event, so opening a
        // stream for it would hang forever — writeHead() only queues headers in Node's
        // internal buffer, it does NOT put anything on the wire until the first write()/
        // end(). Rejecting up front avoids ever entering that state.
        if (!runManager.hasRecordOf(runId)) {
            res.status(404).json({ error: `No run found for id "${runId}".` });
            return;
        }

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        // Flush the queued headers onto the wire immediately, before waiting on any real
        // event. Without this, a legitimately live run (active or queued) with nothing to
        // report yet leaves the client's connection looking identical to a frozen server —
        // no status line, no confirmation the stream is even open. Standard SSE convention.
        res.write(": connected\n\n");

        // subscribe() replays the last known event immediately (if any) before attaching the
        // live listener — this is what prevents a client that connects slightly late (the
        // realistic case: it can't open this connection until it has the runId from the
        // POST response) from silently missing a "queued" or "started" event that already
        // fired. See runManager.ts's own doc comment on subscribe() for why this exists.
        const unsubscribe = runManager.subscribe(runId, (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });

        req.on("close", () => {
            unsubscribe();
            res.end();
        });
    });

    app.post("/api/run/:id/cancel", (req, res) => {
        runManager.cancelRun(req.params.id);
        // Always 200: decideCancelAction's "not-found" branch is a deliberate no-op (per
        // Milestone 2 spec section 4), not an error condition worth surfacing differently —
        // cancelling something that already finished isn't a client mistake worth a 4xx.
        res.status(200).json({ ok: true });
    });

    return { app, runManager };
}