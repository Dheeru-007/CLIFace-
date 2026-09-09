import fs from "node:fs";

export interface HistoryEntry {
    tool: string;
    timestamp: string; // ISO 8601
    flagValues: Record<string, unknown>;
    outputPath: string | null;
    status: "completed" | "error" | "cancelled";
}

/**
 * Builds a single history entry from a run's final state. Pure — no file I/O here, so
 * it's trivially testable. `outputPath` is null for error/cancelled runs, since there's
 * no real output file to point to in those cases.
 */
export function formatHistoryEntry(
    toolId: string,
    formValues: Record<string, unknown>,
    status: "completed" | "error" | "cancelled",
    outputPath: string | null
): HistoryEntry {
    return {
        tool: toolId,
        timestamp: new Date().toISOString(),
        flagValues: formValues,
        outputPath,
        status,
    };
}

/**
 * Appends one entry to the history file as a single JSON line (JSONL format) — simpler
 * and more robust than maintaining one big JSON array on disk, since appending a line
 * never requires reading/rewriting the whole file, and a partially-written line at worst
 * corrupts one entry rather than the entire file. Per the original plan: "simple
 * append-only JSON log, no database needed at this scale."
 *
 * Uses the synchronous fs.appendFileSync deliberately. This is safe under the app's
 * current concurrency model — RunManager runs exactly one active process at a time
 * (single-run-at-a-time, everything else queued), so there is no genuine concurrent-write
 * race on this file today. If that concurrency model ever changes (e.g. parallel runs),
 * this assumption would need revisiting — either an async queue/lock around writes, or a
 * per-write file lock — since concurrent appendFileSync calls from multiple in-flight
 * runs could interleave badly.
 */
export function appendHistoryEntry(historyFilePath: string, entry: HistoryEntry): void {
    fs.appendFileSync(historyFilePath, JSON.stringify(entry) + "\n");
}

/**
 * Reads all history entries back, skipping any line that fails to parse (defensive — a
 * corrupted last line from an interrupted write shouldn't take down the whole history
 * view, just that one entry).
 */
export function readHistory(historyFilePath: string): HistoryEntry[] {
    if (!fs.existsSync(historyFilePath)) return [];
    const raw = fs.readFileSync(historyFilePath, "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    const entries: HistoryEntry[] = [];
    for (const line of lines) {
        try {
            entries.push(JSON.parse(line));
        } catch {
            // Skip corrupted line rather than throwing — see doc comment above.
        }
    }
    return entries;
}