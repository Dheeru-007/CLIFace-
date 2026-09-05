import { useState } from "react";
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

export function ToolForm({ schema }: { schema: ToolSchema }) {
    const [formValues, setFormValues] = useState<FormValues>(() => initialFormValues(schema));
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [presetError, setPresetError] = useState<string | null>(null);

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

            <button type="button" disabled={!canRun} className="run-button">
                Run
            </button>
        </div>
    );
}