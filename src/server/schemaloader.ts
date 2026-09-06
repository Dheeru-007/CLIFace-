import fs from "node:fs";
import path from "node:path";
import type { ToolSchema } from "../engine/buildArgsArray";

/**
 * The curated allowlist — toolId -> schema file path. This IS the security boundary from
 * the Milestone 2 spec: the client only ever names a toolId, never supplies a schema
 * object, so it can never control schema.binary (and therefore never control what
 * spawn() actually launches). Adding a new tool means adding a line here, deliberately —
 * not something a request body can do on its own.
 */
function buildAllowlist(schemasDir: string): Record<string, string> {
    return {
        ffmpeg: path.join(schemasDir, "ffmpeg-schema.json"),
    };
}

export class UnknownToolError extends Error {
    constructor(toolId: string) {
        super(`Unknown toolId: "${toolId}" is not on the curated allowlist.`);
        this.name = "UnknownToolError";
    }
}

/**
 * Loads and parses a schema by toolId, from the server's own curated allowlist — never
 * from anything client-supplied. Caches parsed schemas in memory (schema files don't
 * change at runtime) so repeated requests for the same tool don't re-read/re-parse disk
 * every time.
 */
export function createSchemaLoader(schemasDir: string) {
    const allowlist = buildAllowlist(schemasDir);
    const cache = new Map<string, ToolSchema>();

    return function loadSchema(toolId: string): ToolSchema {
        const cached = cache.get(toolId);
        if (cached) return cached;

        const filePath = allowlist[toolId];
        if (!filePath) throw new UnknownToolError(toolId);

        const raw = fs.readFileSync(filePath, "utf-8");
        const schema = JSON.parse(raw) as ToolSchema;
        cache.set(toolId, schema);
        return schema;
    };
}