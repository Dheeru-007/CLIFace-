# CLI-to-GUI Tool — Final Plan

## 1. Product Definition

**One-liner:** A local app that turns CLI tools into form-based GUIs with plain-English flag explanations and one-click task presets, for early-career devs who know terminals but don't want to memorize flags.

**Target user (locked):** Persona B — comfortable with terminals/flags conceptually, freezes on tools with 30 flags and cryptic docs. Not a total beginner/non-coder.

**Core problem:** CLI tools are powerful but locked behind a memorization barrier. Existing GUI wrappers usually sacrifice power for ease of use — this doesn't.

**Non-goals for v1:**
- No support for arbitrary/unknown CLI tools — curated list only
- No visual node-based pipeline/chaining builder — v2
- No cloud hosting or multi-user accounts — local only
- No LLM-based auto-parsing of `--help` text — schemas hand-authored

## 2. Architecture

Three layers: **Tool Schema** (JSON config per tool) → **Form Renderer** (generic, same code for every tool) → **Execution Engine** (`spawn`, streaming, lifecycle).

```
User picks tool → loads schema → renders form + live command preview →
user fills form or picks preset → buildArgsArray() → spawn → stream output → save result
```

**Tech stack:** React + TypeScript + Vite + Tailwind (frontend), Node.js + Express (backend), WebSockets/SSE for streaming, local JSON files for schema + run history (no DB). **Local dev tool for v1** — no Electron, no Firebase, until real usage demands it.

## 3. Hard Constraints

- **Never build a shell string.** Always `spawn(binary, argsArray)`. No `exec`, no string interpolation, ever.
- **`buildArgsArray(schema, formValues) -> string[]`** is one shared, unit-tested function used by both the live preview and the real `spawn()` call.
- **Live preview needs its own quoting pass** for display (wrap whitespace-containing args in quotes so copy-pasted commands survive a real shell) — separate from the raw array, which needs no escaping.
- **`buildArgsArray` internals:** dispatch on a `kind` field (`standard | boolean | templated | positional`) rather than ad hoc `if (flag === ...)` checks, so new tools reuse one of these four kinds instead of adding one-off branches.

## 4. Schema Conventions (apply to every tool, not just ffmpeg)

- **Optional enum flags:** include an explicit `unsetSentinel` value (e.g. `"__unset__"`) as a real enum option, rendered as the default choice. `buildArgsArray` skips the flag when that sentinel is selected. Never use `default: null` for enums.
- **Optional number flags:** pair with `optional: true` + `enabled: false` by default; input stays disabled until toggled on. `buildArgsArray` skips when not enabled.
- **`conflictsWith` is symmetric by rule**, declared exactly once per pair — on the *primary/basic* flag's entry (e.g. `-crf`, not `-q:v`), never on both sides.
- **Not every advanced flag needs the unset pattern.** Some (e.g. `-b:a`) have a safe universal default and are always passed. The unset/disabled pattern is reserved for flags where omission has distinct meaning to the tool itself (e.g. `-ar` unset lets ffmpeg keep the source's native rate).
- **Validation is layered:** form renderer (clamped sliders, restricted dropdowns) is the primary defense making invalid states unreachable; `buildArgsArray`'s own checks are a safety net for renderer bugs, not the main path.
- **Filename/path validation** forbids leading dashes (so the CLI's own parser doesn't mistake a filename for a flag) in addition to forbidding path separators.
- **Positional args** (like ffmpeg's trailing output filename) are their own `kind`, appended last — not forced into `-flag value` shape.
- **Templated/synthetic flags** (like `-vf:scale` standing in for one filter use) get an `argTemplate` expansion step, documented in the schema's `notes`.
- **Flagged for tool #2, not a v1 blocker:** current schema assumes ffmpeg's space-separated style (`-crf 28`). Tools like yt-dlp use `--flag=value`. May need `argStyle: "space" | "equals"` — check before assuming the function generalizes.

## 5. Process Lifecycle

- **Cancel:** `SIGINT` first (clean shutdown), `SIGKILL` after a timeout if unresponsive.
- **Concurrency:** single-run-at-a-time for v1, additional runs queued.
- **Queue visibility:** not silent — one-line status (`"Queued — 2 ahead of this one"`).
- **Cleanup:** partial/failed outputs deleted via a `tmp/` staging dir; only moved to final output on success.
- **Progress reporting:** `-progress pipe:1` (structured stdout), not stderr scraping.

## 6. File I/O

- **Input:** local file picker → absolute path.
- **Output:** fixed folder for v1 (`~/CLIFace/output/`), no save dialog. Show output path + "reveal in folder." Custom location is v1.1.
- **Run history:** append-only local JSON log (`~/CLIFace/history.json`) — tool, timestamp, flag values, output path, status.

## 7. UX Details

- Basic/Advanced toggle per tool, hiding most flags by default.
- Inline plain-English explanation per flag.
- Live command preview, built alongside the form renderer (not after execution) — doubles as the debugging tool for early milestones.
- Presets: pre-filled form + one-click run for common tasks.

## 8. v1 Scope

Single tool: **ffmpeg**. Schema and engine built to generalize, one tool proven before adding a second.

## 9. Milestone Order

0. ✅ **Done.** Hand-write full ffmpeg schema, no code. Reviewed across three rounds — fixed: unset representation (enum sentinel + disabled-number pattern), templated-flag expansion, symmetric `conflictsWith` (plus ordering rule + one real duplicate-declaration bug), filename validation (leading dash), `-b:a` always-on exception documented, MP3 preset codec-inference flagged for real-run testing.
1. **Next.** Form renderer + live command preview together, built on `buildArgsArray` (kind-dispatch design, unit-tested first).
2. Execution engine: `spawn` + `-progress pipe:1` streaming + cancel/kill + visible queue status.
3. Output file handling + run history (JSON log).
4. Presets wired in.
5. Validate with real usage (including the MP3-codec-inference test).
6. Add tool #2 — proves schema/engine generalize; check `argStyle` assumption here.
7. v2 territory: LLM-assisted schema generation, pipeline chaining, Electron packaging.

## 10. Deliverables So Far

- `ffmpeg-schema.json` — Milestone 0 complete, all review rounds incorporated.

## 11. Next Step

Milestone 1: write the `buildArgsArray` spec (kind dispatch: standard/boolean/templated/positional) and the form renderer, either as an Antigravity build prompt or drafted here first for review — same process as the schema.
