import { describe, it, expect, vi } from "vitest";
import ffmpegSchemaJson from "../schemas/ffmpeg-schema.json";
import type { ToolSchema } from "./buildArgsArray";
import {
    resetConflictingFlags,
    restoreConflictingFlags,
    applyFieldChange,
    hasActiveConflicts,
    canBuildArgs,
    isRequiredFieldUnresolved,
    applyPreset,
    buildPreviewCommand,
} from "./Formlogic";

const ffmpegSchema = ffmpegSchemaJson as unknown as ToolSchema;

function getFlag(flagName: string) {
    const flag = ffmpegSchema.flags.find((f) => f.flag === flagName);
    if (!flag) throw new Error(`Fixture missing flag ${flagName}`);
    return flag;
}

describe("resetConflictingFlags", () => {
    it("resets a conflicting enum/templated flag to its unsetSentinel", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vn"), getFlag("-vf:scale")] };
        const formValues = { "-vn": true, "-vf:scale": "1280:-1" };
        const result = resetConflictingFlags(schema, formValues, "-vn");
        expect(result["-vf:scale"]).toBe("__unset__");
    });

    it("resets a conflicting boolean flag to false", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vn"), getFlag("-an")] };
        const formValues = { "-vn": true, "-an": true };
        const result = resetConflictingFlags(schema, formValues, "-vn");
        expect(result["-an"]).toBe(false);
    });

    it("resets a conflicting optional-number flag to enabled:false while preserving its value", () => {
        // -q:v conflicts with -crf (declared on -crf's side). Activating -crf must disable -q:v
        // without discarding whatever number the user already typed.
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf"), getFlag("-q:v")] };
        const formValues = { "-crf": 28, "-q:v": { value: 15, enabled: true } };
        const result = resetConflictingFlags(schema, formValues, "-crf");
        expect(result["-q:v"]).toEqual({ value: 15, enabled: false });
    });

    it("resolves the conflict regardless of which side declared it (symmetric lookup)", () => {
        // conflictsWith is declared on -crf's entry, not -q:v's. hasActiveConflicts must still
        // find the pair when triggered from the undeclared side (-q:v becoming active).
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf"), getFlag("-q:v")] };
        const formValues = { "-crf": 28, "-q:v": { value: 15, enabled: true } };
        expect(hasActiveConflicts(schema, formValues)).toBe(true);
    });

    it("resolves the -crf/-q:v deadlock (regression): enabling -q:v's override with -crf at its default must reset -crf to unset, not leave it permanently stuck active", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf"), getFlag("-q:v")] };
        // -crf sitting at its ordinary default (23), -q:v just got its override checkbox
        // enabled by the user — the single most obvious intended use of that field.
        const formValues = { "-crf": 23, "-q:v": { value: 10, enabled: true } };

        const result = resetConflictingFlags(schema, formValues, "-q:v");

        expect(result["-crf"]).toBe("__unset__");
        expect(hasActiveConflicts(schema, result)).toBe(false);
    });

    it("restores -crf to its default after -q:v is enabled then disabled (regression): -crf must not be permanently stuck at __unset__ with no path back", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf"), getFlag("-q:v")] };
        const initial = { "-crf": 23, "-q:v": { value: 10, enabled: false } };

        // Enable -q:v's override — -crf gets reset to unset, per the fix above.
        const afterEnable = resetConflictingFlags(
            schema,
            { ...initial, "-q:v": { value: 10, enabled: true } },
            "-q:v"
        );
        expect(afterEnable["-crf"]).toBe("__unset__");

        // Now disable -q:v again — -crf must come back to its schema default (23), not stay
        // stuck at "__unset__" with no way for the user to reach a real value again.
        const afterDisable = restoreConflictingFlags(
            schema,
            { ...afterEnable, "-q:v": { value: 10, enabled: false } },
            "-q:v"
        );
        expect(afterDisable["-crf"]).toBe(23);
    });

    it("restoreConflictingFlags is a no-op for flags that don't need restoring (e.g. -an, which already rests at false)", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vn"), getFlag("-an")] };
        const formValues = { "-vn": false, "-an": false };
        const result = restoreConflictingFlags(schema, formValues, "-vn");
        expect(result).toEqual(formValues);
    });

    it("does nothing when the activated flag has no declared conflicts", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-b:a")] };
        const formValues = { "-b:a": "256k" };
        const result = resetConflictingFlags(schema, formValues, "-b:a");
        expect(result).toEqual(formValues);
    });
});

describe("hasActiveConflicts", () => {
    it("returns true when a declared-conflicting pair is both active", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vn"), getFlag("-vf:scale")] };
        const formValues = { "-vn": true, "-vf:scale": "1280:-1" };
        expect(hasActiveConflicts(schema, formValues)).toBe(true);
    });

    it("returns false in the normal, non-conflicting case", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vn"), getFlag("-vf:scale")] };
        const formValues = { "-vn": true, "-vf:scale": "__unset__" };
        expect(hasActiveConflicts(schema, formValues)).toBe(false);
    });

    it("returns false for -vn alongside the always-on -crf/-preset (the fixed bug)", () => {
        const schema = {
            ...ffmpegSchema,
            flags: [getFlag("-vn"), getFlag("-crf"), getFlag("-preset")],
        };
        const formValues = { "-vn": true, "-crf": 23, "-preset": "medium" };
        expect(hasActiveConflicts(schema, formValues)).toBe(false);
    });
});

describe("canBuildArgs", () => {
    it("true when both required fields (-i, output) are filled", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-i"), getFlag("output")] };
        const result = canBuildArgs(schema, { "-i": "/tmp/in.mp4", output: "out.mp4" });
        expect(result).toBe(true);
    });

    it("false when -i is missing", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-i"), getFlag("output")] };
        const result = canBuildArgs(schema, { output: "out.mp4" });
        expect(result).toBe(false);
    });

    it("false when output is missing", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-i"), getFlag("output")] };
        const result = canBuildArgs(schema, { "-i": "/tmp/in.mp4" });
        expect(result).toBe(false);
    });

    it("false when both are missing", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-i"), getFlag("output")] };
        const result = canBuildArgs(schema, {});
        expect(result).toBe(false);
    });

    it("regression: a hypothetical required+optional flag disabled with a leftover numeric value must NOT be treated as resolved — this is exactly the state buildArgsArray would throw RequiredFieldError on", () => {
        // Hand-built fixture: no real ffmpeg flag currently combines required+optional, but
        // nothing in the schema type rules it out, so canBuildArgs must stay correct anyway.
        const hypotheticalFlag = {
            flag: "--hypothetical",
            kind: "standard" as const,
            type: "number",
            required: true,
            optional: true,
            enabled: false,
        };
        const schema = { ...ffmpegSchema, flags: [hypotheticalFlag] };
        const formValues = { "--hypothetical": { value: 0, enabled: false } };

        expect(isRequiredFieldUnresolved(hypotheticalFlag, formValues)).toBe(true);
        expect(canBuildArgs(schema, formValues)).toBe(false);
    });

    it("the same hypothetical flag counts as resolved once enabled with a real value", () => {
        const hypotheticalFlag = {
            flag: "--hypothetical",
            kind: "standard" as const,
            type: "number",
            required: true,
            optional: true,
            enabled: false,
        };
        const schema = { ...ffmpegSchema, flags: [hypotheticalFlag] };
        const formValues = { "--hypothetical": { value: 5, enabled: true } };

        expect(canBuildArgs(schema, formValues)).toBe(true);
    });
});

describe("applyPreset", () => {
    it("applies a clean, non-conflicting preset and auto-enables optional-number overrides", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf"), getFlag("-r")] };
        const preset = { name: "Test preset", values: { "-crf": 18, "-r": 60 } };
        const result = applyPreset(schema, {}, preset);
        expect(result.applied).toBe(true);
        expect(result.formValues["-crf"]).toBe(18);
        expect(result.formValues["-r"]).toEqual({ value: 60, enabled: true });
    });

    it("rejects a preset that would leave two conflicting flags active, and leaves formValues unchanged", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vn"), getFlag("-vf:scale")] };
        const original = { "-vn": false, "-vf:scale": "__unset__" };
        // Constructed bad-preset fixture: sets both halves of a real conflicting pair active.
        const badPreset = { name: "Broken preset", values: { "-vn": true, "-vf:scale": "1280:-1" } };
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => { });

        const result = applyPreset(schema, original, badPreset);

        expect(result.applied).toBe(false);
        expect(result.formValues).toEqual(original);
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it("the real 'Convert video to MP3' preset applies cleanly (regression coverage at the renderer-logic layer too)", () => {
        const preset = ffmpegSchema.presets!.find((p) => p.name === "Convert video to MP3")!;
        const result = applyPreset(ffmpegSchema, { "-i": "/tmp/in.mp4" }, preset);
        expect(result.applied).toBe(true);
        expect(result.formValues["-vn"]).toBe(true);
    });
});

describe("buildPreviewCommand", () => {
    it("substitutes a placeholder for a missing required field without throwing", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-i"), getFlag("output")] };
        const result = buildPreviewCommand(schema, { output: "out.mp4" });
        // Placeholder text contains spaces, so stringifyArgsForDisplay correctly quotes it —
        // this is the shared-function design paying off: even the placeholder path gets
        // real shell-quoting for free, with no special-casing needed.
        expect(result).toBe('ffmpeg -i "<select input file>" out.mp4');
    });

    it("handles partial fill — one required field present, one missing — in correct relative order", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-i"), getFlag("-crf"), getFlag("output")] };
        const result = buildPreviewCommand(schema, { "-i": "/tmp/in.mp4", "-crf": 28 });
        expect(result).toBe('ffmpeg -i /tmp/in.mp4 -crf 28 "<output filename>"');
    });

    it("matches the real buildArgsArray ordering once a real value replaces the placeholder", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-i"), getFlag("-crf"), getFlag("output")] };
        const withPlaceholder = buildPreviewCommand(schema, { "-i": "/tmp/in.mp4", "-crf": 28 });
        const withRealValue = buildPreviewCommand(schema, {
            "-i": "/tmp/in.mp4",
            "-crf": 28,
            output: "out.mp4",
        });
        // Same shape/order, only the substituted token differs — proves no separate ordering
        // implementation exists between the placeholder and real-value cases.
        expect(withPlaceholder.replace('"<output filename>"', "out.mp4")).toBe(withRealValue);
    });
});

describe("applyFieldChange — the actual field-update entry point components must call", () => {
    it("firing reset when a field transitions inactive -> active (checking -q:v's override)", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf"), getFlag("-q:v")] };
        const formValues = { "-crf": 23, "-q:v": { value: 10, enabled: false } };

        const next = applyFieldChange(schema, formValues, "-q:v", { value: 10, enabled: true });

        expect(next["-crf"]).toBe("__unset__");
        expect(hasActiveConflicts(schema, next)).toBe(false);
    });

    it("firing restore when a field transitions active -> inactive (unchecking -q:v's override)", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf"), getFlag("-q:v")] };
        const formValues = { "-crf": "__unset__", "-q:v": { value: 10, enabled: true } };

        const next = applyFieldChange(schema, formValues, "-q:v", { value: 10, enabled: false });

        expect(next["-crf"]).toBe(23);
    });

    it("does nothing extra for a field with no conflicts (plain passthrough)", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-b:a")] };
        const formValues = { "-b:a": "192k" };
        const next = applyFieldChange(schema, formValues, "-b:a", "256k");
        expect(next).toEqual({ "-b:a": "256k" });
    });

    it("does nothing extra when the change doesn't cross an active/inactive boundary", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf"), getFlag("-q:v")] };
        const formValues = { "-crf": "__unset__", "-q:v": { value: 10, enabled: true } };
        const next = applyFieldChange(schema, formValues, "-q:v", { value: 20, enabled: true });
        expect(next["-crf"]).toBe("__unset__");
        expect(next["-q:v"]).toEqual({ value: 20, enabled: true });
    });
});