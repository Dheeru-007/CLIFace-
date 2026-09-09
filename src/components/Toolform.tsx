import { useState, useRef, useEffect } from "react";
import type { ToolSchema, FormValues } from "../engine/buildArgsArray";
import {
    applyFieldChange,
    canBuildArgs,
    isRequiredFieldUnresolved,
    hasActiveConflicts,
    buildPreviewCommand,
    applyPreset,
} from "../engine/Formlogic";
import { FieldRenderer } from "./Fields";

type RunStatus =
    | { state: "idle" }
    | { state: "queued"; ahead: number }
    | { state: "running"; progress?: Record<string, unknown> }
    | { state: "completed"; outputPath: string }
    | { state: "cancelled" }
    | { state: "error"; message: string };

function initialFormValues(schema: ToolSchema): FormValues {
    const values: FormValues = {};
    for (const flag of schema.flags) {
        if (flag.optional) {
            values[flag.flag] = { value: flag.default ?? 0, enabled: !!flag.enabled };
        } else {
            values[flag.flag] = flag.default ?? "";
        }
    }
    return values;
}

export function ToolForm({ schema, toolId }: { schema: ToolSchema; toolId: string }) {
    const [formValues, setFormValues] = useState<FormValues>(() => initialFormValues(schema));
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [presetError, setPresetError] = useState<string | null>(null);
    const [runStatus, setRunStatus] = useState<RunStatus>({ state: "idle" });
    const [runId, setRunId] = useState<string | null>(null);
    const eventSourceRef = useRef<EventSource | null>(null);

    // Clean up any open SSE connection if the component unmounts mid-run.
    useEffect(() => {
        return () => {
            eventSourceRef.current?.close();
        };
    }, []);

    async function handleRun() {
        setRunStatus({ state: "queued", ahead: 0 });

        let response: Response;
        try {
            response = await fetch("/api/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Only toolId + formValues — never a schema object. The server loads the real
                // schema itself from its own curated allowlist; sending a schema here wouldn't
                // do anything even if we tried, since the server ignores that field entirely.
                body: JSON.stringify({ toolId, formValues }),
            });
        } catch (err) {
            setRunStatus({ state: "error", message: "Could not reach the server." });
            return;
        }

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setRunStatus({ state: "error", message: body.error ?? `Request failed (${response.status}).` });
            return;
        }

        const { runId: newRunId } = await response.json();
        setRunId(newRunId);

        const es = new EventSource(`/api/run/${newRunId}/events`);
        eventSourceRef.current = es;

        es.onmessage = (msg) => {
            const event = JSON.parse(msg.data);
            switch (event.type) {
                case "queued":
                    setRunStatus({ state: "queued", ahead: event.ahead });
                    break;
                case "started":
                    setRunStatus({ state: "running" });
                    break;
                case "progress":
                    setRunStatus({ state: "running", progress: event });
                    break;
                case "completed":
                    setRunStatus({ state: "completed", outputPath: event.outputPath });
                    es.close();
                    break;
                case "cancelled":
                    setRunStatus({ state: "cancelled" });
                    es.close();
                    break;
                case "error":
                    setRunStatus({ state: "error", message: event.message });
                    es.close();
                    break;
            }
        };

        es.onerror = () => {
            // A dropped connection mid-run isn't necessarily a failed run — the process may
            // still be running server-side. Surface it distinctly from a real "error" event
            // rather than claiming the run itself failed.
            setRunStatus((current) =>
                current.state === "running" || current.state === "queued"
                    ? { state: "error", message: "Lost connection to the server." }
                    : current
            );
            es.close();
        };
    }

    async function handleCancel() {
        if (!runId) return;
        await fetch(`/api/run/${runId}/cancel`, { method: "POST" });
    }

    // The ONLY place any field's change is applied. Every FieldRenderer's onChange prop
    // points here — never directly at setFormValues, and never directly at
    // resetConflictingFlags/restoreConflictingFlags. This is what makes the
    // activation/deactivation wiring provably connected rather than just implemented in
    // formLogic.ts in isolation.
    function handleFieldChange(flagName: string, newValue: unknown) {
        setFormValues((current) => applyFieldChange(schema, current, flagName, newValue));
    }

    function handlePresetSelect(preset: { name: string; values: Record<string, unknown> }) {
        const result = applyPreset(schema, formValues, preset);
        if (result.applied) {
            setFormValues(result.formValues);
            setPresetError(null);
        } else {
            setPresetError(`Couldn't apply "${preset.name}" — it conflicts with itself. This is a preset bug, please report it.`);
        }
    }

    const basicFlags = schema.flags.filter((f) => !f.advanced);
    const advancedFlags = schema.flags.filter((f) => f.advanced);
    const hiddenRequiredCount = advancedFlags.filter((f) =>
        isRequiredFieldUnresolved(f, formValues)
    ).length;

    const canRun = canBuildArgs(schema, formValues) && !hasActiveConflicts(schema, formValues);
    const previewCommand = buildPreviewCommand(schema, formValues);

    return (
        <div className="tool-form">
            <h2>{schema.tool as string}</h2>
            <p>{schema.blurb as string}</p>

            {schema.presets && (
                <div className="preset-picker">
                    <label>Quick presets:</label>
                    <select
                        defaultValue=""
                        onChange={(e) => {
                            const preset = (schema.presets as any[]).find((p) => p.name === e.target.value);
                            if (preset) handlePresetSelect(preset);
                            e.target.value = "";
                        }}
                    >
                        <option value="" disabled>
                            Choose a preset…
                        </option>
                        {(schema.presets as any[]).map((p) => (
                            <option key={p.name} value={p.name}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                    {presetError && <p className="error">{presetError}</p>}
                </div>
            )}

            <div className="basic-fields">
                {basicFlags.map((flag) => (
                    <FieldRenderer
                        key={flag.flag}
                        flag={flag}
                        formValues={formValues}
                        onChange={handleFieldChange}
                    />
                ))}
            </div>

            {advancedFlags.length > 0 && (
                <div className="advanced-section">
                    <button type="button" onClick={() => setShowAdvanced((v) => !v)}>
                        {showAdvanced ? "Hide" : "Show"} advanced options
                        {hiddenRequiredCount > 0 && !showAdvanced ? ` (${hiddenRequiredCount} required)` : ""}
                    </button>
                    {showAdvanced && (
                        <div className="advanced-fields">
                            {advancedFlags.map((flag) => (
                                <FieldRenderer
                                    key={flag.flag}
                                    flag={flag}
                                    formValues={formValues}
                                    onChange={handleFieldChange}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="command-preview">
                <label>Command preview:</label>
                <pre>{previewCommand}</pre>
            </div>

            <div className="run-controls">
                {(runStatus.state === "queued" || runStatus.state === "running") ? (
                    <button type="button" onClick={handleCancel} className="cancel-button">
                        Cancel
                    </button>
                ) : (
                    <button type="button" disabled={!canRun} onClick={handleRun} className="run-button">
                        Run
                    </button>
                )}
            </div>

            <div className="run-status">
                {runStatus.state === "queued" && <p>Queued — {runStatus.ahead} run(s) ahead of this one.</p>}
                {runStatus.state === "running" && (
                    <p>
                        Running…
                        {runStatus.progress && (
                            <span className="progress-detail">
                                {" "}
                                {Object.entries(runStatus.progress)
                                    .filter(([k]) => k !== "type")
                                    .map(([k, v]) => `${k}: ${v}`)
                                    .join(", ")}
                            </span>
                        )}
                    </p>
                )}
                {runStatus.state === "completed" && (
                    <p className="success">Done — saved to {runStatus.outputPath}</p>
                )}
                {runStatus.state === "cancelled" && <p>Cancelled.</p>}
                {runStatus.state === "error" && <p className="error">Error: {runStatus.message}</p>}
            </div>
        </div>
    );
}