// Milestone 1a — buildArgsArray + stringifyArgsForDisplay unit tests
//
// Written against milestone-1-spec.md, section 5, BEFORE either function body exists.
// These imports will fail until buildArgsArray.ts and stringifyArgsForDisplay.ts are written
// to satisfy them — that failure is the point of writing tests first.

import { describe, it, expect } from "vitest";
import ffmpegSchemaJson from "../schemas/ffmpeg-schema.json";
import { buildArgsArray, ConflictError, RequiredFieldError, type ToolSchema } from "./buildArgsArray";
import { stringifyArgsForDisplay } from "./stringifyArgsForDisplay";

// JSON imports widen literal types (e.g. FlagKind) to plain `string` — cast once here so
// every test below gets real type-checking against buildArgsArray's actual parameter types.
const ffmpegSchema = ffmpegSchemaJson as unknown as ToolSchema;

// Convenience: pull a single flag's schema entry by its flag name, for tests
// that want to isolate one flag rather than build a full form.
function getFlag(flagName: string) {
    const flag = ffmpegSchema.flags.find((f: any) => f.flag === flagName);
    if (!flag) throw new Error(`Fixture is missing flag ${flagName} — test setup is broken`);
    return flag;
}

describe("buildArgsArray — kind: standard", () => {
    it("pushes '-flag' then the value as two separate array entries", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf")] };
        const result = buildArgsArray(schema, { "-crf": 28 });
        expect(result).toEqual(["-crf", "28"]);
    });

    it("does not concatenate flag and value into a single string", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf")] };
        const result = buildArgsArray(schema, { "-crf": 28 });
        expect(result).not.toContain("-crf 28");
    });
});

describe("buildArgsArray — kind: boolean", () => {
    it("pushes the flag alone when true", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vn")] };
        const result = buildArgsArray(schema, { "-vn": true });
        expect(result).toEqual(["-vn"]);
    });

    it("pushes nothing when false", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vn")] };
        const result = buildArgsArray(schema, { "-vn": false });
        expect(result).toEqual([]);
    });
});

describe("buildArgsArray — kind: templated", () => {
    it("expands a real (non-sentinel) value into the template's real tokens, not the synthetic flag name", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vf:scale")] };
        const result = buildArgsArray(schema, { "-vf:scale": "1280:-1" });
        expect(result).toEqual(["-vf", "scale=1280:-1"]);
        expect(result).not.toContain("-vf:scale");
    });

    it("skips the flag entirely when the unset sentinel is selected, rather than expanding scale=__unset__", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-vf:scale")] };
        const result = buildArgsArray(schema, { "-vf:scale": "__unset__" });
        expect(result).toEqual([]);
    });
});

describe("buildArgsArray — kind: positional", () => {
    it("appends the positional field as its own entry", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("output")] };
        const result = buildArgsArray(schema, { output: "clip.mp4" });
        expect(result).toEqual(["clip.mp4"]);
    });

    it("always lands last in the array, regardless of the flag's position in schema.flags", () => {
        // output is defined LAST in the real schema; -crf is defined much earlier.
        // Reordering the flags array here to put output FIRST must not change the output order.
        // Deliberately using -crf and -preset (no conflictsWith relationship between them) so
        // this test isolates ordering behavior only, not the conflict-checking path.
        const schema = {
            ...ffmpegSchema,
            flags: [getFlag("output"), getFlag("-crf"), getFlag("-preset")],
        };
        const result = buildArgsArray(schema, {
            output: "clip.mp4",
            "-crf": 28,
            "-preset": "fast",
        });
        expect(result).toEqual(["-crf", "28", "-preset", "fast", "clip.mp4"]);
    });
});

describe("buildArgsArray — unset conventions", () => {
    it("enum unset sentinel: skips the flag entirely (e.g. -ar left at default)", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-ar")] };
        const result = buildArgsArray(schema, { "-ar": "__unset__" });
        expect(result).toEqual([]);
    });

    it("enum non-sentinel value: includes the flag normally", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-ar")] };
        const result = buildArgsArray(schema, { "-ar": "48000" });
        expect(result).toEqual(["-ar", "48000"]);
    });

    it("optional number with enabled: false skips the flag, even with a nonzero value present", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-r")] };
        const result = buildArgsArray(schema, { "-r": { value: 60, enabled: false } });
        expect(result).toEqual([]);
    });

    it("optional number with enabled: true includes the flag", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-r")] };
        const result = buildArgsArray(schema, { "-r": { value: 60, enabled: true } });
        expect(result).toEqual(["-r", "60"]);
    });
});

describe("buildArgsArray — always-on-default flags", () => {
    it("includes an always-on-default flag (e.g. -b:a) at its schema default when the user never touches it", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-b:a")] };
        // formValues intentionally omits "-b:a" entirely — simulating "user never touched this field."
        // buildArgsArray must fall back to schema.default, not silently drop the flag the way an
        // unset-sentinel or disabled-number flag would.
        const result = buildArgsArray(schema, {});
        expect(result).toEqual(["-b:a", "192k"]);
    });
});

describe("buildArgsArray — defensive validation (renderer-bug safety net, not primary path)", () => {
    it("clamps an out-of-range number rather than passing it through or throwing", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf")] }; // range [0, 51]
        const result = buildArgsArray(schema, { "-crf": 999 });
        expect(result).toEqual(["-crf", "51"]);
    });

    it("clamps below the minimum too", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf")] };
        const result = buildArgsArray(schema, { "-crf": -10 });
        expect(result).toEqual(["-crf", "0"]);
    });

    it("skips an enum flag entirely if given a value outside its declared enum list", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-preset")] };
        const result = buildArgsArray(schema, { "-preset": "not-a-real-preset" });
        expect(result).toEqual([]);
    });

    it("throws a structured ConflictError when two conflicting flags are both active", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-crf"), getFlag("-q:v")] };
        const formValues = {
            "-crf": 28,
            "-q:v": { value: 10, enabled: true }, // both "active" simultaneously — should be unreachable via the renderer
        };
        expect(() => buildArgsArray(schema, formValues)).toThrow(ConflictError);

        try {
            buildArgsArray(schema, formValues);
        } catch (err) {
            expect(err).toBeInstanceOf(ConflictError);
            expect((err as ConflictError).flagA).toBe("-crf");
            expect((err as ConflictError).flagB).toBe("-q:v");
        }
    });

    it("throws RequiredFieldError when a required flag has no value and no default (e.g. -i missing)", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("-i")] };
        expect(() => buildArgsArray(schema, {})).toThrow(RequiredFieldError);
    });

    it("throws RequiredFieldError when a required positional flag has no value (e.g. output missing)", () => {
        const schema = { ...ffmpegSchema, flags: [getFlag("output")] };
        expect(() => buildArgsArray(schema, {})).toThrow(RequiredFieldError);
    });
});

describe("buildArgsArray — full realistic preset, end-to-end", () => {
    it("does NOT throw for the 'Convert video to MP3' preset — regression test for a real bug where -vn's conflictsWith previously included -crf/-preset, which are always-on-default flags with no valid inactive state, making this preset permanently unresolvable", () => {
        const preset = ffmpegSchema.presets!.find(
            (p: any) => p.name === "Convert video to MP3"
        )!;
        const result = buildArgsArray(ffmpegSchema, { ...preset.values, "-i": "/tmp/input.mp4" });
        // Exact array, not just arrayContaining — order and completeness both matter here.
        // -crf/-preset appear at their always-on defaults (23, medium); ffmpeg just ignores
        // them harmlessly since there's no video stream to apply them to.
        expect(result).toEqual([
            "-i", "/tmp/input.mp4",
            "-crf", "23",
            "-preset", "medium",
            "-vn",
            "-b:a", "192k",
            "audio.mp3",
        ]);
    });

    it("produces the exact expected array for the 'Compress video for email' preset", () => {
        const preset = ffmpegSchema.presets!.find(
            (p: any) => p.name === "Compress video for email"
        )!;
        // -i is supplied by the file picker at runtime, never by a preset — merging it in here
        // to simulate that real flow, now that a missing required flag throws rather than skips.
        const result = buildArgsArray(ffmpegSchema, { ...preset.values, "-i": "/tmp/input.mp4" });
        // Order: standard/boolean/templated flags in schema-definition order, positional last.
        // Schema order: -i(unused here), -vf:scale, -crf, -preset, ... , output
        expect(result).toEqual([
            "-i", "/tmp/input.mp4",
            "-vf", "scale=1280:-1",
            "-crf", "28",
            "-preset", "medium",
            "-b:a", "192k", // always-on-default, included even though the preset doesn't set it
            "compressed.mp4",
        ]);
    });
});

describe("stringifyArgsForDisplay", () => {
    it("joins a plain args array with the binary name, no quoting needed", () => {
        const result = stringifyArgsForDisplay("ffmpeg", ["-crf", "28"]);
        expect(result).toBe("ffmpeg -crf 28");
    });

    it("wraps a whitespace-containing entry in double quotes for display only", () => {
        const result = stringifyArgsForDisplay("ffmpeg", ["-i", "/Users/me/My Videos/clip.mp4"]);
        expect(result).toBe('ffmpeg -i "/Users/me/My Videos/clip.mp4"');
    });

    it("escapes an embedded double quote inside a whitespace-containing entry", () => {
        const result = stringifyArgsForDisplay("ffmpeg", ["-i", '/Users/me/My "Special" Videos/clip.mp4']);
        expect(result).toBe('ffmpeg -i "/Users/me/My \\"Special\\" Videos/clip.mp4"');
    });

    it("escapes an embedded backslash inside a whitespace-containing entry", () => {
        const result = stringifyArgsForDisplay("ffmpeg", ["-i", "C:\\My Videos\\clip.mp4"]);
        expect(result).toBe('ffmpeg -i "C:\\\\My Videos\\\\clip.mp4"');
    });

    it("does not quote or escape entries with no whitespace", () => {
        const result = stringifyArgsForDisplay("ffmpeg", ["-crf", "28", "-preset", "medium"]);
        expect(result).toBe("ffmpeg -crf 28 -preset medium");
    });
});