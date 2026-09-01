// buildArgsArray — pure function, no I/O, no side effects.
// Dispatches on each flag's explicit schema-declared `kind`. Never infers kind.
// See milestone-1-spec.md section 1 for the full contract this implements.

export class ConflictError extends Error {
    flagA: string;
    flagB: string;

    constructor(flagA: string, flagB: string) {
        super(`Conflicting flags both active: ${flagA} and ${flagB}`);
        this.name = "ConflictError";
        this.flagA = flagA;
        this.flagB = flagB;
    }
}

export class RequiredFieldError extends Error {
    flag: string;

    constructor(flag: string) {
        super(`Required flag '${flag}' has no value and no default — form renderer should have prevented this.`);
        this.name = "RequiredFieldError";
        this.flag = flag;
    }
}

type FlagKind = "standard" | "boolean" | "templated" | "positional";

interface FlagSchema {
    flag: string;
    kind: FlagKind;
    type: string;
    default?: unknown;
    enum?: string[];
    unsetSentinel?: string;
    optional?: boolean;
    enabled?: boolean;
    range?: [number, number];
    argTemplate?: string;
    validation?: { conflictsWith?: string[] };
}

export interface ToolSchema {
    binary: string;
    flags: FlagSchema[];
    presets?: Array<{ name: string; description?: string; values: Record<string, unknown> }>;
    [key: string]: unknown;
}

type FormValues = Record<string, unknown>;

interface Resolved {
    value: unknown;
    enabled: boolean;
}

/**
 * Resolves a single flag's schema + formValues into a concrete {value, enabled} pair.
 * Handles the two "unset" conventions:
 *  - optional numbers: value/enabled live together as { value, enabled } in formValues
 *  - everything else: falls back to schema.default when formValues omits the key entirely
 */
function resolveValue(flagSchema: FlagSchema, formValues: FormValues): Resolved {
    const raw = formValues[flagSchema.flag];

    if (flagSchema.optional) {
        if (raw !== undefined && typeof raw === "object" && raw !== null && "enabled" in raw) {
            const obj = raw as { value: unknown; enabled: boolean };
            return { value: obj.value, enabled: !!obj.enabled };
        }
        // Field never touched at all — fall back to schema's own enabled default (false unless stated).
        return { value: flagSchema.default, enabled: !!flagSchema.enabled };
    }

    if (raw === undefined) {
        return { value: flagSchema.default, enabled: true };
    }
    return { value: raw, enabled: true };
}

/**
 * Whether a flag counts as "meaningfully unset" and should be omitted from the output
 * entirely — covers the enum-sentinel and disabled-number conventions, invalid enum
 * values (defensive safety net), and the case where no value and no default exist at all.
 */
function isSkipped(flagSchema: FlagSchema, resolved: Resolved): boolean {
    if (flagSchema.optional && !resolved.enabled) return true;
    if (flagSchema.unsetSentinel !== undefined && resolved.value === flagSchema.unsetSentinel) {
        return true;
    }
    if (
        flagSchema.enum &&
        resolved.value !== undefined &&
        !flagSchema.enum.includes(resolved.value as string)
    ) {
        // Defensive safety net only — the renderer should never let an out-of-list value
        // reach here. Skip rather than pass an unvalidated string through to spawn.
        return true;
    }
    if (resolved.value === undefined || resolved.value === "") {
        // No explicit value and nothing to fall back to (e.g. a required field the caller
        // never populated) — never emit a flag with no real value attached.
        return true;
    }
    return false;
}

function clamp(value: number, range?: [number, number]): number {
    if (!range) return value;
    const [min, max] = range;
    return Math.min(max, Math.max(min, value));
}

/**
 * Whether a flag is "active" for the purposes of conflictsWith checking — i.e. it will
 * actually be emitted with a real, user-meaningful value, not skipped/defaulted-away.
 */
function isActive(flagSchema: FlagSchema, resolved: Resolved): boolean {
    if (flagSchema.kind === "boolean") return resolved.value === true;
    if (flagSchema.optional) return resolved.enabled === true;
    if (flagSchema.unsetSentinel !== undefined) return resolved.value !== flagSchema.unsetSentinel;
    return resolved.value !== undefined && resolved.value !== "";
}

export function buildArgsArray(schema: ToolSchema, formValues: FormValues): string[] {
    const resolvedByFlag = new Map<string, Resolved>();
    for (const flagSchema of schema.flags) {
        resolvedByFlag.set(flagSchema.flag, resolveValue(flagSchema, formValues));
    }

    // conflictsWith is checked before any array is built — this should be structurally
    // unreachable if the form renderer disabled conflicting fields correctly (spec section 3).
    for (const flagSchema of schema.flags) {
        const conflicts = flagSchema.validation?.conflictsWith;
        if (!conflicts || conflicts.length === 0) continue;

        const resolvedSelf = resolvedByFlag.get(flagSchema.flag)!;
        if (!isActive(flagSchema, resolvedSelf)) continue;

        for (const otherFlagName of conflicts) {
            const otherSchema = schema.flags.find((f) => f.flag === otherFlagName);
            if (!otherSchema) continue;
            const resolvedOther = resolvedByFlag.get(otherFlagName)!;
            if (isActive(otherSchema, resolvedOther)) {
                throw new ConflictError(flagSchema.flag, otherFlagName);
            }
        }
    }

    const nonPositional: string[] = [];
    const positional: string[] = [];

    for (const flagSchema of schema.flags) {
        const resolved = resolvedByFlag.get(flagSchema.flag)!;

        if (flagSchema.kind === "positional") {
            if (resolved.value !== undefined && resolved.value !== "") {
                positional.push(String(resolved.value));
                continue;
            }
            // No value at all — same required-check that standard/templated flags go through
            // below. Positional flags (e.g. output) must not silently vanish from the command
            // just because this branch returns early; a missing required positional is exactly
            // the "wrong output with no indication anything was misconfigured" failure mode
            // convention:required-missing exists to prevent.
            if ("required" in flagSchema && (flagSchema as { required?: boolean }).required) {
                throw new RequiredFieldError(flagSchema.flag);
            }
            continue;
        }

        if (isSkipped(flagSchema, resolved)) {
            if ("required" in flagSchema && (flagSchema as { required?: boolean }).required) {
                throw new RequiredFieldError(flagSchema.flag);
            }
            continue;
        }

        if (flagSchema.kind === "boolean") {
            if (resolved.value === true) {
                nonPositional.push(flagSchema.flag);
            }
            continue;
        }

        if (flagSchema.kind === "templated") {
            const expanded = flagSchema.argTemplate!.replace("{value}", String(resolved.value));
            nonPositional.push(...expanded.split(" "));
            continue;
        }

        // kind === "standard"
        let value: unknown = resolved.value;
        if (typeof value === "number" && flagSchema.range) {
            value = clamp(value, flagSchema.range);
        }
        nonPositional.push(flagSchema.flag, String(value));
    }

    return [...nonPositional, ...positional];
}