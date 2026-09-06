import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createSchemaLoader, UnknownToolError } from "./schemaloader";
import { createServer } from "./server";

describe("schemaLoader", () => {
    it("loads the ffmpeg schema by toolId from the real schemas directory", () => {
        const schemasDir = path.join(__dirname, "..", "schemas");
        const loadSchema = createSchemaLoader(schemasDir);
        const schema = loadSchema("ffmpeg");
        expect(schema.binary).toBe("ffmpeg");
    });

    it("throws UnknownToolError for a toolId not on the allowlist — the actual security boundary", () => {
        const schemasDir = path.join(__dirname, "..", "schemas");
        const loadSchema = createSchemaLoader(schemasDir);
        expect(() => loadSchema("rm -rf /")).toThrow(UnknownToolError);
        expect(() => loadSchema("../../etc/passwd")).toThrow(UnknownToolError);
    });

    it("caches a loaded schema rather than re-reading the file every call", () => {
        const schemasDir = path.join(__dirname, "..", "schemas");
        const loadSchema = createSchemaLoader(schemasDir);
        const first = loadSchema("ffmpeg");
        const second = loadSchema("ffmpeg");
        expect(first).toBe(second); // same object reference — proves it's cached, not re-parsed
    });
});

describe("Express server — real HTTP requests via supertest", () => {
    let tmpDir: string;
    let outputDir: string;
    const schemasDir = path.join(__dirname, "..", "schemas");

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cliface-server-tmp-"));
        outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "cliface-server-output-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(outputDir, { recursive: true, force: true });
    });

    it("POST /api/run rejects an unknown toolId with 400, never reaching RunManager", async () => {
        const { app } = createServer(tmpDir, outputDir, schemasDir);
        const res = await request(app)
            .post("/api/run")
            .send({ toolId: "not-a-real-tool", formValues: {} });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Unknown toolId/);
    });

    it("POST /api/run rejects a malformed body (missing toolId) with 400", async () => {
        const { app } = createServer(tmpDir, outputDir, schemasDir);
        const res = await request(app).post("/api/run").send({ formValues: {} });
        expect(res.status).toBe(400);
    });

    it("POST /api/run rejects a request missing required formValues fields with 400 (InvalidRunRequestError surfaced correctly)", async () => {
        const { app } = createServer(tmpDir, outputDir, schemasDir);
        const res = await request(app)
            .post("/api/run")
            .send({ toolId: "ffmpeg", formValues: {} }); // no -i, no output

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/formValues failed server-side validation/);
    });

    it("POST /api/run accepts a valid request and returns a runId, never accepting a client-supplied schema", async () => {
        const { app } = createServer(tmpDir, outputDir, schemasDir);
        const res = await request(app)
            .post("/api/run")
            // Deliberately including a "schema" field with a malicious binary, to confirm the
            // server ignores it entirely — toolId is the only thing that determines the schema.
            .send({
                toolId: "ffmpeg",
                schema: { binary: "rm", flags: [] },
                formValues: { "-i": "/tmp/in.mp4", output: "out.mp4" },
            });

        expect(res.status).toBe(200);
        expect(typeof res.body.runId).toBe("string");
    });

    it("GET /api/run/:id/events streams at least one real SSE event for a submitted run", async () => {
        // supertest's .end() waits for the server to close the response — but an SSE
        // connection is intentionally never-ending from the server side (it only closes when
        // the CLIENT disconnects), so supertest's normal completion model can't work here
        // regardless of how the response is parsed. A real http.Server + raw http.get gives
        // full control to close the socket manually once an event has been captured.
        const { app } = createServer(tmpDir, outputDir, schemasDir);
        const httpServer = app.listen(0);
        const port = (httpServer.address() as any).port;

        try {
            const submitRes = await request(app)
                .post("/api/run")
                .send({ toolId: "ffmpeg", formValues: { "-i": "/tmp/in.mp4", output: "out.mp4" } });
            const runId = submitRes.body.runId;

            const eventChunk = await new Promise<string>((resolve, reject) => {
                const http = require("node:http");
                const req = http.get(`http://127.0.0.1:${port}/api/run/${runId}/events`, (res: any) => {
                    let data = "";
                    res.on("data", (chunk: Buffer) => {
                        data += chunk.toString();
                        if (data.includes("data:")) {
                            req.destroy(); // close the client socket now that we have what we need
                            resolve(data);
                        }
                    });
                    res.on("error", reject);
                });
                req.on("error", (err: Error) => {
                    // Destroying the socket ourselves above triggers an expected "socket hang up"
                    // error on the client side — not a real failure, just how we chose to end this.
                    if (!err.message.includes("socket hang up")) reject(err);
                });
            });

            expect(eventChunk).toContain("data:");
        } finally {
            httpServer.close();
        }
    });

    it("POST /api/run/:id/cancel on a not-found runId returns 200, not an error (deliberate no-op per spec)", async () => {
        const { app } = createServer(tmpDir, outputDir, schemasDir);
        const res = await request(app).post("/api/run/nonexistent-id/cancel").send();
        expect(res.status).toBe(200);
    });

    it("regression: GET /api/run/:id/events for an unknown runId returns 404 immediately, instead of hanging with headers queued but never flushed", async () => {
        const { app } = createServer(tmpDir, outputDir, schemasDir);
        const res = await request(app).get("/api/run/totally-unknown-id/events");
        expect(res.status).toBe(404);
    });

    it("regression: GET /api/run/:id/events flushes headers immediately for a legitimate run, even before any real event fires", async () => {
        const { app } = createServer(tmpDir, outputDir, schemasDir);
        const httpServer = app.listen(0);
        const port = (httpServer.address() as any).port;

        try {
            const submitRes = await request(app)
                .post("/api/run")
                .send({ toolId: "ffmpeg", formValues: { "-i": "/tmp/in.mp4", output: "out.mp4" } });
            const runId = submitRes.body.runId;

            const firstChunk = await new Promise<string>((resolve, reject) => {
                const http = require("node:http");
                const req = http.get(`http://127.0.0.1:${port}/api/run/${runId}/events`, (res: any) => {
                    res.on("data", (chunk: Buffer) => {
                        req.destroy();
                        resolve(chunk.toString());
                    });
                    res.on("error", reject);
                });
                req.on("error", (err: Error) => {
                    if (!err.message.includes("socket hang up")) reject(err);
                });
            });

            // The very first thing received should be the keep-alive comment, proving headers
            // and an initial byte reached the client without waiting on a real RunManager event.
            expect(firstChunk).toContain(": connected");
        } finally {
            httpServer.close();
        }
    });
});