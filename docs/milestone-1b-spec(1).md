# Milestone 1b Spec — Form Renderer + Live Command Preview

Builds on Milestone 1a. `buildArgsArray` and `stringifyArgsForDisplay` are trusted, tested
building blocks here. This revision folds in a second review round that surfaced real
state-management gaps (conflict-reset semantics, placeholder-preview duplication risk,
required-field visibility) beyond the first round's three open questions.

## 1. Component shape

```
<ToolForm schema={ffmpegSchema} />
```

One generic component, driven entirely by the schema passed in — no per-tool component code.

```
ToolForm
├── state: formValues (see section 2)
├── FieldRenderer (one per flag, dispatches on flag.type)
│   ├── FileField      (type: "file")
│   ├── BooleanField   (type: "boolean")
│   ├── EnumField      (type: "enum")
│   ├── NumberField    (type: "number")
│   └── StringField    (type: "string")
├── PresetPicker (section 7)
├── BasicAdvancedToggle (section 8)
└── CommandPreview (section 6)
```

Out of scope for 1b: switching `schema` on a live `ToolForm` instance. Changing tools means
mounting a new `ToolForm` with a new schema and fresh `formValues` — not a supported
in-place transition. Not a gap, just stated explicitly so it isn't assumed to work.

## 2. formValues state shape

- **boolean flags:** `formValues[flag] = true | false`
- **standard/string flags (non-optional):** `formValues[flag] = <raw value>`
- **file flags:** `formValues[flag] = <absolute path string>`, or `""` for "no file selected
  yet." `""` is the canonical empty state — never `null`/`undefined` — so `canBuildArgs` and
  every other resolution path can treat "empty" as a single, consistent check
  (`value === ""`) across every string-shaped field type, including file.
- **enum flags:** `formValues[flag] = <one of flag.enum's actual string values>`.
  `unsetSentinel`, where present, is a **real member of `flag.enum`** (e.g. `-vf:scale`'s
  enum literally contains `"__unset__"`) — not an external/undefined marker. This must be
  true of every future tool schema too: an unset-capable enum's sentinel is always a normal
  entry in its own `enum` array.
- **optional number flags** (`optional: true`): `formValues[flag] = { value: number, enabled: boolean }`.
- **templated flags:** same shape as enum — `formValues[flag] = <selected enum value, possibly the unsetSentinel>`.
- **positional flags:** `formValues[flag] = <raw string>`, `""` for empty, same as a plain string field.

Initial state on mount: every non-optional flag defaults to `flag.default` (or `""` if no
default exists, e.g. `-i`/`output`); every optional number flag initializes to
`{ value: flag.default ?? 0, enabled: flag.enabled ?? false }`.

### Shared helpers — single source of truth, both exported from buildArgsArray.ts

`buildArgsArray.ts` exports **two** functions the renderer must reuse rather than
reimplementing, plus their supporting types (`FlagSchema`, `FormValues`, `Resolved`,
`ToolSchema`):

- **`resolveValue(flagSchema, formValues) -> Resolved`** — turns a raw `formValues` entry
  into the `{ value, enabled }` shape every other check operates on. The renderer needs this
  to produce a `Resolved` object before it can call the second function below — without it,
  1b would end up reinventing the exact per-type resolution rules (unset sentinels,
  optional-number enabled/disabled, always-on defaults) a second time, which is precisely
  the drift this section exists to prevent.
- **`isFlagActive(flagSchema, resolved) -> boolean`** — given a `Resolved` value, says
  whether the flag counts as "active" for conflict-checking purposes. Reused directly by
  section 4's conflict-disabling logic and section 11's `canBuildArgs`/`hasActiveConflicts`.

Both functions, and the types they operate on, are the single source of truth. There is one
implementation of "resolve a flag's value" and one implementation of "is this flag active" —
the engine and the UI both call the same code, never two independently-maintained copies.

## 3. Field rendering rules (primary validation layer — makes invalid states unreachable)

- **`type: "file"`** → file picker. On selection, store the absolute path as a plain string.
  No text-entry fallback. `formValues[flag] === ""` renders as "no file selected" in the UI
  — this is the field's normal empty state, not an error state, and not represented as
  `null`. **Cancel:** if the user opens the picker and cancels, `formValues[flag]` is left
  unchanged (whatever it was before — `""` or a previously selected path). **Picker error:**
  show an inline error message; do not write anything to `formValues` on failure.
- **`type: "boolean"`** → toggle/checkbox bound directly to `formValues[flag]`.
- **`type: "enum"`** → dropdown populated only from `flag.enum`. If `flag.unsetSentinel` is
  present, its entry renders first and is selected by default.
- **`type: "number"`:**
  - Non-optional: plain numeric input, hard-clamped at the input level to `flag.range`.
  - `flag.optional: true`: disabled numeric input + "Enable override" checkbox. Checking
    the box sets `enabled: true` and makes the input editable; unchecking sets
    `enabled: false` and disables it again without clearing `value` — a user experimenting
    with frame rate shouldn't lose their number just because they unchecked the box.
    **The same `flag.range` clamp applies once the field is enabled** — this is easy to
    forget because it's a structurally separate component branch from the non-optional
    number field, so it's called out explicitly here rather than assumed.
- **`type: "string"`** → plain text input. If `flag.validation.pattern` exists, validated on
  blur. **Resolved behavior on invalid input:** the input keeps showing exactly what the
  user typed, with an inline error message — it does **not** revert to the last valid
  value. `formValues[flag]`, however, is **not** updated with the invalid text; it retains
  its last-valid value underneath until the input passes validation. This means the live
  preview (section 6), which reads from `formValues`, can lag one edit behind what's
  visibly typed in the field while it's mid-error — that's intentional, not a bug: the
  preview always reflects the last value that was actually valid enough to build a real
  command with.

## 4. `conflictsWith` enforcement

When a flag becomes active (per the shared `isFlagActive` helper), every flag named in its
`validation.conflictsWith` list is disabled in the form, enforced symmetrically regardless
of which side declared the relationship (per `convention:conflicts-symmetric`).

**Disabling is a real state transition, not just a visual grey-out.** The moment flag A
becomes active and disables flag B, B's value in `formValues` is force-reset to its
"inactive" equivalent for its kind:
- boolean → `false`
- enum/templated → `flag.unsetSentinel` (if it has one)
- optional number → `{ value: <preserved>, enabled: false }`

This is what actually keeps `ConflictError` unreachable. Merely greying out a control while
leaving its old active value sitting in `formValues` would mean a still-conflicting state
reaches `buildArgsArray` the moment any other form change triggers a rebuild — the visual
disable alone doesn't prevent that.

**Real bug found and fixed while validating this section against the actual schema:**
`-vn`'s `conflictsWith` originally also listed `-crf` and `-preset` — but those two are
always-on-default flags (no `unsetSentinel`, no `optional`), so `isFlagActive` returns
`true` for them unconditionally; there was no valid "inactive" state to force-reset them
into. This made the "Convert video to MP3" preset (which sets `-vn` but doesn't mention
`-crf`/`-preset`) permanently unresolvable — every application of that preset would land in
a state `hasActiveConflicts` correctly flagged as broken. **Fixed at the schema level, not
the renderer level:** confirmed real ffmpeg treats an unused encoder option like `-crf`/
`-preset` (irrelevant once `-vn` removes the video stream) as a harmless non-fatal warning,
not an error — so they were removed from `-vn`'s `conflictsWith` entirely. `-vf:scale`
stays in the list, since filtering a video stream that doesn't exist is a real ffmpeg error,
unlike an ignored encoder parameter. This is why section 4's force-reset logic only ever
needs to handle flags that actually have a valid inactive state — a flag being listed in
`conflictsWith` is now a schema-authoring invariant: only list a flag there if it can
genuinely be reset to something.

**Transitive/chained conflicts are explicitly out of scope for v1.** The lookup is single-hop
only (given flag A, find everything that conflicts with A directly, in either direction) —
if A conflicts with B and B conflicts with C, activating A does not cascade to re-checking
C. No chain currently exists in the ffmpeg schema, so this isn't live-broken today; it's
documented here as a known v1 limitation so it isn't silently assumed to be handled if a
future tool's schema does have one.

## 5. Required fields

- Required fields (`required: true`, e.g. `-i`, `output`) render with a visible "required"
  indicator.
- The **Run** button's enabled state depends on **both**:
  1. `canBuildArgs(schema, formValues)` returning `true` (every required field resolves to
     a non-empty value) — see section 11.
  2. `hasActiveConflicts(schema, formValues)` returning `false` — an independent, defensive
     second check that no two conflicting flags are simultaneously active, so a bug in
     section 4's reset logic doesn't silently leave Run enabled in a conflicting state with
     nothing else standing in the way.
- If a required field is nested inside the collapsed "Advanced" section (section 8), its
  required-ness must still be visible without expanding — see section 8's badge
  requirement. A user should never be stuck with a disabled Run button and zero visible
  explanation.

## 6. Live Command Preview

- Rendered alongside the form, updating on every `formValues` change.
- **No parallel implementation of argument ordering.** The earlier draft of this spec had
  the preview hand-build a placeholder string when required fields were empty — that would
  have meant a second, independent implementation of flag ordering/formatting that had to
  stay in sync with `buildArgsArray` by convention alone, with nothing enforcing it. Instead:
  1. Clone `formValues`.
  2. For each `required: true` flag that currently resolves to empty, set the clone's value
     to a placeholder string (e.g. `"<select input file>"` for `-i`, `"<output filename>"`
     for `output`).
  3. Call the **real** `buildArgsArray(schema, clonedValues)` and
     `stringifyArgsForDisplay(schema.binary, result)` on that clone.
  Because this goes through the actual functions, ordering can never drift from what Run
  will really do, and **partial fill is handled for free** — if `-i` is set but `output`
  isn't, the clone only substitutes a placeholder for `output`, producing e.g.
  `ffmpeg -i /path/to/input.mp4 -crf 28 <output filename>` — one real value, one
  placeholder, in the correct relative positions, with no special-casing needed for "some
  required fields filled, others not."
- The try/catch around this call is now purely a safety net for the genuinely-unreachable
  `ConflictError` path (section 4's reset logic should prevent this outright) — if it fires
  anyway, log it loudly to the console in dev, since it means section 4 has a bug.

## 7. Presets

- `PresetPicker` renders `schema.presets` as a simple list/dropdown.
- Selecting a preset **replaces** the relevant keys in `formValues` with the preset's
  `values` object — fields the preset doesn't mention keep their current value. `-i` is
  never touched by preset selection.
- For optional number fields a preset sets a value for, the renderer sets `enabled: true`
  automatically.
- **After applying a preset, the same conflict-reset pass from section 4 runs across the
  resulting `formValues`** — not just for flags the user directly toggles. If a preset's own
  values (or the combination of a preset's values with an unrelated flag the user already
  had active) would leave two conflicting flags simultaneously active, this is treated as a
  **schema/preset-authoring bug**, exactly like a stray `ConflictError` would be: log a
  clear console error identifying both flags and the preset name, and **do not apply the
  preset** — leave `formValues` at whatever it was before selection, rather than committing
  a broken state. This makes a bad preset a caught bug at selection time, not a silent path
  into the "unreachable" conflicting state.

## 8. Basic / Advanced grouping

- Fields with `advanced: false` (or unset) render in the main form body.
- Fields with `advanced: true` render inside a collapsed section behind a single toggle,
  collapsed by default.
- **If any hidden advanced field is `required: true` and currently unresolved**, the toggle
  itself shows a badge/count (e.g. "Show advanced options (1 required)") — so a disabled
  Run button always has a visible, findable reason, even before expanding the section.
- The toggle is pure UI state — it doesn't affect what `buildArgsArray` receives.

## 9. Inline explanations

Each field shows `flag.plainEnglish` via an info icon or expandable caption, not a
permanently-visible paragraph.

## 10. Out of scope for 1b (explicitly deferred)

- Actually running the command (Milestone 2).
- Output folder handling, run history (Milestone 3).
- Visual/styling polish beyond "functional and readable."
- Live schema-switching on a mounted `ToolForm` (section 1).
- Resolving transitive/chained conflicts (section 4).

## 11. canBuildArgs / hasActiveConflicts

```
canBuildArgs(schema: ToolSchema, formValues: FormValues) -> boolean
hasActiveConflicts(schema: ToolSchema, formValues: FormValues) -> boolean
```

Both are small, pure predicates, and both **reuse the exported `isFlagActive` /
value-resolution helpers from `buildArgsArray.ts`** rather than reimplementing per-type
resolution rules a second time (see section 2's shared-helper note) — this is what prevents
the two-implementations-must-stay-in-sync hazard a from-scratch reimplementation would
create.

- **`canBuildArgs`** iterates every flag with `required: true` in the schema — this
  includes both standard-kind flags (`-i`) and positional-kind flags (`output`) — and
  returns `false` if any resolve to an empty value. It checks this directly against the
  schema, independent of whatever `buildArgsArray`'s own internal exception behavior
  happens to do, so it stays correct even if that implementation changes later.
- **`hasActiveConflicts`** iterates every flag with a `validation.conflictsWith` entry,
  checks `isFlagActive` on both sides, and returns `true` if any declared pair is
  simultaneously active. Used as the Run button's defensive second check (section 5) — it
  should always return `false` in practice if section 4's reset logic is correct, which is
  exactly why it's worth checking independently rather than trusting that alone.

The Run button is enabled only when `canBuildArgs` returns `true` **and**
`hasActiveConflicts` returns `false`.

## 12. Testing requirements for 1b

Unlike a pure visual-polish milestone, this one is full of state-transition logic (conflict
resets, preset application, required-field resolution) that needs the same "written and
tested before it ships" treatment 1a got, not just component/visual testing. Concretely:

- **Extract the state-transition logic into pure functions, separate from React
  components** — a `resetConflictingFlags(schema, formValues, activatedFlag)` reducer-style
  function, an `applyPreset(schema, formValues, preset)` function, plus `canBuildArgs` and
  `hasActiveConflicts` from section 11. None of these need a DOM or a component to be
  tested.
- Minimum required unit tests before the renderer ships:
  - `resetConflictingFlags`: activating a flag correctly resets each conflicting flag to its
    kind-appropriate inactive state (boolean → false, enum → unsetSentinel, optional number
    → `enabled: false` with value preserved).
  - `applyPreset`: a preset whose values don't conflict applies cleanly; a preset that would
    create a conflict (constructed test fixture, not necessarily one from the real schema)
    is rejected and leaves `formValues` unchanged.
  - `canBuildArgs`: true when both `-i` and `output` are filled; false when either is
    missing; false when both are missing.
  - `hasActiveConflicts`: true when two declared-conflicting flags are both forced active
    via a hand-built `formValues` fixture; false in the normal case.
  - Live preview's placeholder-substitution: given a clone with only `-i` empty, confirm
    the resulting stringified command has the placeholder in `-i`'s position and real values
    everywhere else, and that ordering matches a real `buildArgsArray` call with an actual
    input path substituted in.
