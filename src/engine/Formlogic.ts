import {
    type ToolSchema,
    type FlagSchema,
    type FormValues,
    resolveValue,
    isFlagActive,
    buildArgsArray,
    ConflictError,
} from "./buildArgsArray";
import { stringifyArgsForDisplay } from "./stringifyArgsForDisplay";

/**
 * Every flag that conflicts with `flagName`, in either direction — regardless of which
 * side declared the relationship in the schema (convention:conflicts-symmetric).
 */
function findConflictsOf(schema: ToolSchema, flagName: string): FlagSchema[] {
    const self = schema.flags.find((f) => f.flag === flagName);
    const declaredByOther = schema.flags.filter((f) =>
        f.validation?.conflictsWith?.includes(flagName)
    );
    const declaredBySelf = (self?.validation?.conflictsWith ?? [])
        .map((otherName) => schema.flags.find((f) => f.flag === otherName))
        .filter((f): f is FlagSchema => f !== undefined);

    const all = [...declaredByOther, ...declaredBySelf];
    // de-duplicate by flag name
    const seen = new Set<string>();
    return all.filter((f) => {
        if (seen.has(f.flag)) return false;
        seen.add(f.flag);
        return true;
    });
}

/**
 * The "inactive equivalent" value for a flag, used when force-resetting a conflicting
 * flag. Only ever called on flags that are legitimately capable of being inactive —
 * per the schema-authoring invariant established in the 1b spec, a flag should only be
 * listed in someone's conflictsWith if it has a valid inactive state.
 */
function inactiveValueFor(flagSchema: FlagSchema, currentRaw: unknown): unknown {
    if (flagSchema.kind === "boolean") return false;

    if (flagSchema.optional) {
        // Preserve whatever value was typed; just flip enabled off.
        const current =
            currentRaw && typeof currentRaw === "object" && "value" in (currentRaw as object)
                ? (currentRaw as { value: unknown }).value
                : flagSchema.default;
        return { value: current, enabled: false };
    }

    if (flagSchema.unsetSentinel !== undefined) return flagSchema.unsetSentinel;

    // No valid inactive state exists for this flag. This should never happen if the schema
    // convention is followed (see -vn's conflictsWith fix — always-on-default flags must
    // never be listed as a conflict target). Leave it unchanged rather than guessing, and
    // let hasActiveConflicts surface the problem loudly instead of silently corrupting state.
    return currentRaw;
}

/**
 * The mirror of inactiveValueFor, for the deactivation direction. Deliberately narrow in
 * scope: only the "non-optional flag with unsetSentinel" case (Section 3's third UI case
 * — currently only -crf) has a schema default that differs from its own inactive value,
 * so it's the only kind that needs an explicit restore. Boolean/enum/optional-number
 * flags already rest naturally at their inactive value (or intentionally require a
 * manual reactivation, e.g. -q:v's checkbox) — for those, this returns undefined,
 * meaning "no restore needed," not "restore to undefined."
 */
function restoreValueFor(flagSchema: FlagSchema): unknown {
    if (
        !flagSchema.optional &&
        flagSchema.kind !== "boolean" &&
        flagSchema.unsetSentinel !== undefined
    ) {
        return flagSchema.default;
    }
    return undefined;
}

/**
 * Fires when `deactivatedFlagName` transitions from active to inactive. For each flag it
 * conflicts with, restores it to its schema default IF that flag is currently sitting at
 * its own inactive value AND restoreValueFor says it actually needs restoring (see scope
 * note above). Never touches a conflicting flag that's independently active for some
 * other reason — while a flag like -crf sits disabled, nothing else can have changed it
 * (Section 3 specifies it as non-interactive in that state), so there's no risk of
 * clobbering an unrelated edit by restoring unconditionally here.
 */
export function restoreConflictingFlags(
    schema: ToolSchema,
    formValues: FormValues,
    deactivatedFlagName: string
): FormValues {
    const conflicts = findConflictsOf(schema, deactivatedFlagName);
    if (conflicts.length === 0) return formValues;

    const next = { ...formValues };
    for (const conflictingFlag of conflicts) {
        const resolved = resolveValue(conflictingFlag, next);
        if (isFlagActive(conflictingFlag, resolved)) continue; // independently active — don't touch
        const restored = restoreValueFor(conflictingFlag);
        if (restored !== undefined) {
            next[conflictingFlag.flag] = restored;
        }
    }
    return next;
}

/**
 * Force-resets every flag that conflicts with `activatedFlagName` to its inactive
 * equivalent. Returns a new formValues object; does not mutate the input.
 */
export function resetConflictingFlags(
    schema: ToolSchema,
    formValues: FormValues,
    activatedFlagName: string
): FormValues {
    const conflicts = findConflictsOf(schema, activatedFlagName);
    if (conflicts.length === 0) return formValues;

    const next = { ...formValues };
    for (const conflictingFlag of conflicts) {
        next[conflictingFlag.flag] = inactiveValueFor(
            conflictingFlag,
            formValues[conflictingFlag.flag]
        );
    }
    return next;
}

/**
 * The single entry point every field's onChange should call. Detects whether this change
 * transitions the flag from inactive→active or active→inactive (using the same
 * isFlagActive/resolveValue helpers as everywhere else), and fires resetConflictingFlags
 * or restoreConflictingFlags accordingly. This exists specifically so the
 * activation/deactivation wiring is a tested pure function, not something that only
 * "looks correct" by reading through a React component's onChange prop — the component
 * layer should never call resetConflictingFlags/restoreConflictingFlags directly itself.
 */
export function applyFieldChange(
    schema: ToolSchema,
    formValues: FormValues,
    flagName: string,
    newValue: unknown
): FormValues {
    const flagSchema = schema.flags.find((f) => f.flag === flagName);
    if (!flagSchema) return { ...formValues, [flagName]: newValue };

    const wasActive = isFlagActive(flagSchema, resolveValue(flagSchema, formValues));
    const next = { ...formValues, [flagName]: newValue };
    const isNowActive = isFlagActive(flagSchema, resolveValue(flagSchema, next));

    if (!wasActive && isNowActive) return resetConflictingFlags(schema, next, flagName);
    if (wasActive && !isNowActive) return restoreConflictingFlags(schema, next, flagName);
    return next;
}

/**
 * True if any declared conflictsWith pair is simultaneously active in formValues.
 * Defensive, independent check — used both after preset application and as the Run
 * button's second gate (section 5/11), not relied on as the only line of defense.
 */
export function hasActiveConflicts(schema: ToolSchema, formValues: FormValues): boolean {
    for (const flagSchema of schema.flags) {
        const conflicts = flagSchema.validation?.conflictsWith;
        if (!conflicts || conflicts.length === 0) continue;

        const resolvedSelf = resolveValue(flagSchema, formValues);
        if (!isFlagActive(flagSchema, resolvedSelf)) continue;

        for (const otherName of conflicts) {
            const otherSchema = schema.flags.find((f) => f.flag === otherName);
            if (!otherSchema) continue;
            const resolvedOther = resolveValue(otherSchema, formValues);
            if (isFlagActive(otherSchema, resolvedOther)) return true;
        }
    }
    return false;
}

/**
 * True only if every required flag (standard or positional) resolves to a non-empty
 * value. Checked directly against the schema's `required` field — never inferred by
 * observing buildArgsArray's exception behavior, so it stays correct independent of that
 * function's internals.
 */
/**
 * Whether a single required flag currently fails to resolve to a real, usable value —
 * the per-flag check both canBuildArgs and the renderer's "required fields hidden in
 * Advanced" badge need. Exported so ToolForm never reimplements this inline; a second,
 * independently-drifting copy of "is this required field unresolved" is exactly the kind
 * of duplication this project has repeatedly centralized (isFlagActive, resolveValue).
 *
 * Correctly handles a flag that is BOTH required:true and optional:true — a combination
 * that shouldn't exist in a well-authored schema (required implies the user must supply
 * it; optional+disabled-by-default implies the opposite), but isn't ruled out by the type
 * system, so this stays correct regardless of what a future tool's schema does. A required
 * flag that's also optional-shaped counts as unresolved when its enabled is false, even if
 * it's holding some leftover numeric value — matching exactly what buildArgsArray's
 * isSkipped + required-throw logic would do with the same input, so this predicate can
 * never disagree with what actually happens on Run.
 */
export function isRequiredFieldUnresolved(
    flagSchema: FlagSchema,
    formValues: FormValues
): boolean {
    if (!("required" in flagSchema) || !(flagSchema as { required?: boolean }).required) {
        return false;
    }
    const resolved = resolveValue(flagSchema, formValues);
    if (flagSchema.optional && !resolved.enabled) return true;
    return resolved.value === undefined || resolved.value === "";
}

export function canBuildArgs(schema: ToolSchema, formValues: FormValues): boolean {
    for (const flagSchema of schema.flags) {
        if (isRequiredFieldUnresolved(flagSchema, formValues)) return false;
    }
    return true;
}

export interface ApplyPresetResult {
    formValues: FormValues;
    applied: boolean;
    error?: string;
}

/**
 * Applies a preset's values on top of formValues (wholesale replace of the keys the
 * preset mentions, everything else untouched), auto-enabling any optional-number field
 * the preset sets a value for.
 *
 * Two distinct conflict cases are handled differently, deliberately:
 *  1. The preset's OWN values contain two flags that directly conflict with each other —
 *     this is a preset/schema-authoring bug. Checked in isolation (as if applied to a
 *     blank form) BEFORE any merge happens, so this case can never be silently resolved
 *     by reset ordering — it's rejected outright, formValues left unchanged.
 *  2. A flag the preset activates conflicts with some OTHER, unrelated flag that's simply
 *     already active in the current form (not touched by this preset at all) — this is
 *     normal interaction with prior state, not a preset bug, and is resolved the same way
 *     a direct user toggle would: the stale unrelated flag gets force-reset.
 */
export function applyPreset(
    schema: ToolSchema,
    formValues: FormValues,
    preset: { name: string; values: Record<string, unknown> }
): ApplyPresetResult {
    const presetKeys = new Set(Object.keys(preset.values));

    // Build a view of ONLY the preset's own values (as if starting from a blank form),
    // with optional-number fields wrapped the same way the real merge will wrap them.
    const presetOnlyValues: FormValues = {};
    for (const [flagName, rawValue] of Object.entries(preset.values)) {
        const flagSchema = schema.flags.find((f) => f.flag === flagName);
        presetOnlyValues[flagName] =
            flagSchema?.optional ? { value: rawValue, enabled: true } : rawValue;
    }

    // Case 1: the preset conflicts with itself. Reject before ever touching real formValues.
    if (hasActiveConflicts(schema, presetOnlyValues)) {
        console.error(
            `Preset "${preset.name}" sets two mutually conflicting flags active in its own ` +
            `values — rejected before merging. This is a preset-authoring bug, not a user error.`
        );
        return { formValues, applied: false, error: "preset-self-conflicting" };
    }

    // Merge the preset's (self-consistent) values into current formValues.
    let next = { ...formValues };
    for (const [flagName, value] of Object.entries(presetOnlyValues)) {
        next[flagName] = value;
    }

    // Case 2: reset any conflicting flag that ISN'T also one of the preset's own keys —
    // stale unrelated state left over from before the preset was applied. Flags the preset
    // itself set are never touched here; they already passed the self-consistency check.
    for (const flagName of presetKeys) {
        const flagSchema = schema.flags.find((f) => f.flag === flagName);
        if (!flagSchema) continue;
        const resolved = resolveValue(flagSchema, next);
        if (!isFlagActive(flagSchema, resolved)) continue;

        const conflicts = findConflictsOf(schema, flagName).filter((f) => !presetKeys.has(f.flag));
        for (const conflictingFlag of conflicts) {
            next[conflictingFlag.flag] = inactiveValueFor(conflictingFlag, next[conflictingFlag.flag]);
        }
    }

    // Final defensive check — should be unreachable if the above logic is correct, but
    // caught rather than silently shipped if it somehow isn't.
    if (hasActiveConflicts(schema, next)) {
        console.error(
            `Preset "${preset.name}" still produces conflicting active flags after reset — ` +
            `rejected. This indicates a bug in applyPreset's reset logic, not a user error.`
        );
        return { formValues, applied: false, error: "conflicting-preset" };
    }

    return { formValues: next, applied: true };
}

const PLACEHOLDER_TEXT: Record<string, string> = {
    "-i": "<select input file>",
    output: "<output filename>",
};

/**
 * Builds the live preview string. Clones formValues, substitutes a placeholder string
 * into any required flag that's currently empty, then calls the REAL buildArgsArray /
 * stringifyArgsForDisplay on that clone — so ordering can never drift from what Run will
 * actually do, and partial fill (one required field done, one missing) is handled for
 * free with no special-casing.
 */
export function buildPreviewCommand(schema: ToolSchema, formValues: FormValues): string {
    const clone = { ...formValues };

    for (const flagSchema of schema.flags) {
        if (!("required" in flagSchema) || !(flagSchema as { required?: boolean }).required) {
            continue;
        }
        const resolved = resolveValue(flagSchema, clone);
        if (resolved.value === undefined || resolved.value === "") {
            clone[flagSchema.flag] = PLACEHOLDER_TEXT[flagSchema.flag] ?? `<${flagSchema.flag}>`;
        }
    }

    try {
        const args = buildArgsArray(schema, clone);
        return stringifyArgsForDisplay(schema.binary, args);
    } catch (err) {
        if (err instanceof ConflictError) {
            // Should be unreachable if resetConflictingFlags/hasActiveConflicts are wired up
            // correctly in the renderer — logged loudly rather than silently swallowed, since
            // it means section 4's disabling logic has a real bug.
            console.error("buildPreviewCommand hit an unreachable ConflictError:", err);
            return `${schema.binary} <conflicting flags — this should not happen>`;
        }
        throw err;
    }
}