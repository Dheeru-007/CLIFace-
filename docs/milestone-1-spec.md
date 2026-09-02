# Milestone 1 Spec — buildArgsArray + Form Renderer + Live Preview

## 1. buildArgsArray — function contract

```
buildArgsArray(schema: ToolSchema, formValues: FormValues) -> string[]
```

Pure function. No I/O, no side effects. Same output for the same input, every time — this is what makes it unit-testable in isolation before anything touches the UI or a real `spawn()` call.

### Dispatch model

Every flag in a schema's `flags[]` array declares an explicit `kind` field (`standard | boolean | templated | positional`) — this is a first-class schema property, not something `buildArgsArray` infers from other signals like `flag === "output"` or the presence of `argTemplate`. Inference would just relocate the same ad hoc per-flag branching into a hidden second function instead of eliminating it, which defeats the point of the kind-dispatch model. The ffmpeg schema has been patched to add `kind` explicitly to every flag (see `notes.convention:explicit-kind`); every future tool schema must do the same — there is no default `kind`, and a flag missing one is a schema error, not something the function should guess at.

`buildArgsArray` dispatches purely on the declared `kind`, no fifth value added ad hoc without updating this spec first:

**`kind: "standard"`** — a normal `-flag value` pair.
- Input: `{ flag: "-crf", type: "number", ... }`, form value `28`
- Output: pushes `"-crf"`, then `"28"` — two separate array entries, never concatenated.
- Applies to: `-crf`, `-preset`, `-r`, `-ar`, `-b:a`, `-ss`, `-t`.

**`kind: "boolean"`** — presence/absence only, no value.
- Input: `{ flag: "-vn", type: "boolean" }`, form value `true`
- Output: pushes `"-vn"` only if `true`. Pushes nothing if `false`.
- Applies to: `-vn`, `-an`.

**`kind: "templated"`** — one schema entry expands into a real multi-token ffmpeg argument via `argTemplate`.
- Input: `{ flag: "-vf:scale", argTemplate: "-vf scale={value}" }`, form value `"1280:-1"`
- Output: template is split on whitespace into real tokens: pushes `"-vf"`, then `"scale=1280:-1"` — never the raw literal `"-vf:scale"`, never a single concatenated string.
- Applies to: `-vf:scale` (v1's only templated flag; future tools may add more).

**`kind: "positional"`** — no flag name, appended as a bare trailing argument.
- Input: `{ flag: "output", type: "string" }`, form value `"clip.mp4"`
- Output: pushed as its own array entry, always at the **end** of the array, after every standard/boolean/templated entry — regardless of the flag's position in the schema's `flags[]` list.
- Applies to: `output` (v1's only positional field).

### Unset handling (applies inside standard/templated dispatch, checked before building any tokens for that flag)

- **Enum fields:** if the selected value equals the flag's `unsetSentinel`, skip the flag entirely — push nothing, no template expansion, regardless of kind.
- **Number fields:** if `optional: true` and `enabled: false`, skip the flag entirely — push nothing, ignore whatever numeric value sits in the disabled input.
- Fields without `optional`/`unsetSentinel` (like `-b:a`) are always included using their current value.

### Validation enforcement inside buildArgsArray (secondary safety net only — primary enforcement is in the form renderer, section 3)

- **Range (number fields):** clamp to `range: [min, max]` before pushing. If a value somehow arrives out of range, clamp rather than throw — the renderer should have prevented this, so treat it as a renderer bug being caught, not a user error to surface.
- **Enum (enum fields):** if the value isn't in the flag's `enum` list, skip the flag entirely (treat as if unset) rather than passing an arbitrary string through to `spawn`.
- **conflictsWith:** if two conflicting flags are both "active" (boolean true, or enum/number not unset) in the same formValues, throw with a clear error naming both flags — this should never actually happen if the renderer disables conflicting fields correctly (section 3), so treat it as a caught bug, not a normal user path. **Error shape:** throw a structured `ConflictError` (extends `Error`), carrying `{ flagA: string, flagB: string }` fields alongside a human-readable interpolated message (e.g. `"Conflicting flags both active: -crf and -q:v"`). A plain `Error` with only a string loses the structured data a caller (or a future error boundary in 1b) would want to act on immediately if this ever actually fires — the structured fields cost nothing extra to include now and pay off the one time this path triggers for real.

### Output

Final array = all standard/boolean/templated tokens, in schema-definition order, followed by all positional tokens, in schema-definition order. This exact array is passed directly to `spawn(binary, argsArray)` — no further transformation.

## 2. Display stringification — separate function, own quoting pass

```
stringifyArgsForDisplay(binary: string, argsArray: string[]) -> string
```

Used **only** by the live command preview, never by `spawn`. Takes the same array `buildArgsArray` produced and joins it into a human-readable command string:
- Each array entry containing whitespace gets wrapped in double quotes for the display string only.
- Entries with no whitespace are left bare.
- Joined with single spaces, prefixed with the schema's `binary` (e.g. `"ffmpeg"`).

This function exists specifically so a user can copy the preview text into a real terminal and have it survive shell parsing (e.g. a path with a space in it) — a concern that doesn't apply to the raw array going into `spawn`, which needs no escaping since there's no shell involved.

**Escaping embedded quotes/backslashes:** if a whitespace-containing entry also contains a literal `"` or `\`, escape it (`\"` and `\\` respectively) before wrapping in the outer quotes, so the copy-pasted string parses correctly in a real shell. This is unlikely to trigger for v1's ffmpeg schema (no field currently allows arbitrary quote characters), but the function's contract should handle it rather than silently producing a string that looks fine but breaks if pasted. **Explicit scope limit:** this function is a best-effort convenience for common cases (spaces, basic punctuation) — it targets typical shell quoting (POSIX-style double-quote escaping) and is not a guarantee of correctness across every shell (cmd.exe, PowerShell, and POSIX shells all quote differently). It is never a shell-safety mechanism for `spawn` itself, which needs it not at all.

## 3. Form Renderer requirements

One generic renderer, driven entirely by the schema — no per-tool rendering code.

- **Field type → input mapping:** `file` → file picker, `boolean` → toggle/checkbox, `enum` → dropdown (only the schema's declared `enum` values are selectable — this is what makes bad enum values structurally unreachable, not just caught later), `number` → numeric input clamped to `range` at the input level (can't type or slide outside it), `string` → text input, validated against `validation.pattern` if present, on blur.
- **Optional-number fields:** render disabled/greyed out until the user toggles `enabled` on — matches the `enabled: false` default from the schema.
- **Optional-enum fields:** the `unsetSentinel` entry renders as the first option, labeled from `enumLabels` (e.g. "No change" / "Default (keep source)"), and is selected by default.
- **conflictsWith enforcement (primary path):** when a flag becomes "active" (boolean on, or non-unset value chosen), every flag in its `conflictsWith` list is disabled in the form — treated as symmetric regardless of which side declared it, per the schema convention. Disabling, not just warning, is what makes the conflict structurally unreachable.
- **Basic/Advanced grouping:** fields with `advanced: false` render in the main view; `advanced: true` fields are collapsed behind an "Advanced" toggle, per flag group.
- **Inline explanation:** each field shows its `plainEnglish` text (tooltip or expandable, not a wall of text upfront).
- **Presets:** selecting a preset from `schema.presets` overwrites the current form's values wholesale with the preset's `values` object, including toggling `enabled` on for any optional number field the preset sets a value for.

## 4. Live Command Preview requirements

- Rendered alongside the form (same view, not a separate step) — updates on every form change.
- Pipeline: current form values → `buildArgsArray(schema, formValues)` → `stringifyArgsForDisplay(argsArray)` → displayed string, prefixed with the binary name.
- Shown in a monospace, copyable text block.
- This is the same `buildArgsArray` call that will later feed `spawn()` in Milestone 2 — no separate "preview logic" that could drift from the real execution logic.

## 5. Unit tests required before this touches the UI

`buildArgsArray` tested in isolation against the ffmpeg schema, covering at minimum:
- Each of the 4 kinds individually (standard, boolean, templated, positional)
- Enum unset sentinel → flag skipped
- Number `enabled: false` → flag skipped, even with a nonzero value present
- Number `enabled: true` → flag included
- Always-on-default flag with no `optional`/`unsetSentinel` (e.g. `-b:a`), left untouched by the user → still appears in the output using its schema `default` (`"192k"`), confirming the unset-handling logic doesn't accidentally suppress flags that were never meant to be optional
- Boolean true → flag present; boolean false → flag absent
- Templated flag with a real (non-sentinel) value → correctly expands into two tokens, not a literal synthetic flag name
- Positional (`output`) always lands last in the array, regardless of schema field order
- Range clamping on an out-of-range number (defensive path)
- Enum value not in the allowed list → flag skipped (defensive path)
- `conflictsWith` violation → throws a `ConflictError` with `{ flagA, flagB }` matching the two active conflicting flags (defensive path)
- Full realistic form (a preset's values) → produces the exact expected array end-to-end

`stringifyArgsForDisplay` tested separately:
- Array with a whitespace-containing entry → wrapped in quotes in the string, unquoted in the original array
- Array with no whitespace entries → plain space-joined string

## 6. Decisions (resolved)

1. **`conflictsWith` violation reaching `buildArgsArray`: throws.** This path should be structurally unreachable if the form renderer's disabling logic (section 3) is correct, so a thrown error is the intended signal of a renderer bug — silently dropping one flag would instead produce a wrong output file with no indication anything was misconfigured.
2. **Live preview shows the full runnable command, including the binary name** (`ffmpeg ...`), not just the arguments. This is more honest about what's actually executing, and avoids a user pasting bare args after typing something other than `ffmpeg` and getting a confusing, unrelated shell error.
3. **Milestone 1 is split into 1a and 1b** (see section 7) rather than one milestone with tests as a checklist item — mirroring the Milestone 0 pattern where writing the artifact with no code attached surfaced problems before they were expensive to fix.

## 7. Milestone split

**Milestone 1a — `buildArgsArray` + `stringifyArgsForDisplay`, no UI.**
Write the unit tests from section 5 first, as assertions against this spec, before writing either function's body. Then write the functions to satisfy the tests. No renderer, no live preview, no form — just the two pure functions, verified in isolation.

**Milestone 1b — Form renderer + live command preview, consuming the now-verified functions from 1a.**
Only begins once 1a's tests pass. The renderer calls `buildArgsArray` and `stringifyArgsForDisplay` as already-trusted building blocks — this milestone is about the schema-driven UI (field type mapping, conflictsWith disabling, basic/advanced grouping, presets) and wiring the live preview to update on form change, not about re-verifying the array-building logic.
