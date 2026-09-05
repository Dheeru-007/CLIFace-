# Milestone 2 Spec — Execution Engine

Consumes the now-verified `buildArgsArray` output. This is backend (Express) code — where
the built command actually runs as a real subprocess.

## 1. Endpoints

```
POST /api/run          → starts a run (or queues it), returns { runId }
GET  /api/run/:id/events → SSE stream of progress/logs/completion for that run
POST /api/run/:id/cancel → requests cancellation of a running or queued run
```

`POST /api/run` body: `{ toolId: string, formValues: FormValues }` — **never a `schema`
object**. The client only names which already-curated tool it wants (e.g. `"ffmpeg"|`); it
never gets to describe what a "tool" is. The server maintains its own allowlist mapping
`toolId → schema file path` under `src/schemas/`, loads the schema itself, and rejects any
`toolId` not on that list.

This isn't just tidiness — it's the actual security boundary, and it's load-bearing. If the
client could supply the full `schema` object instead of just an id, it would directly
control `schema.binary`, and `spawn(schema.binary, argsArray)` with an attacker- or
bug-supplied `binary` can launch anything, no matter how carefully `buildArgsArray`
constructs the argument array from `formValues`. This is precisely the door the very first
planning document's non-goals closed ("No support for arbitrary/unknown CLI tools — only a
curated, hand-supported list") — a client-suppliable schema reopens it at the one layer
(the server) that's supposed to be the trust boundary. `buildArgsArray` being called
server-side only protects the *argument array*; the *binary itself* has to be pinned by the
server's own curated list, never taken from the request.

## 2. Spawning — hard constraint, restated

`spawn(schema.binary, argsArray)` only, where `schema` is loaded server-side from the
curated allowlist (section 1) — never a value taken from the request body. Never `exec`,
never a shell string, never string interpolation into a command. This isn't new — it's
the constraint from the original plan — but it's restated here because this is the first
milestone where it's actually load-bearing in real, running code rather than a principle
waiting to matter, and because section 1's fix above is what makes `schema.binary`
trustworthy in the first place.

## 3. Progress reporting

`-progress pipe:1` produces structured `key=value` lines on stdout, separate from ffmpeg's
normal stderr logging — chosen over stderr-scraping for exactly the reason the original
plan gives (fragile, version-dependent). The server parses these lines and forwards them
as SSE progress events.

**Insertion point matters and is not a trailing append.** `buildArgsArray`'s contract
(fixed since the 1a spec) is `[...nonPositional, ...positional]` — `output` is always
last. Real ffmpeg requires output-related options like `-progress` to appear *before* the
output filename, not after; naively pushing `["-progress", "pipe:1"]` onto the end of the
array would insert it after `output`, which ffmpeg will reject or silently ignore —
defeating the entire reason `-progress pipe:1` was chosen over stderr-scraping in the
first place.

**v1 mechanism, stated explicitly:** since Run is only reachable once `canBuildArgs`
confirms every required field resolves, and the ffmpeg schema has exactly one positional
flag (`output`, `required: true`), the array's last element is always the resolved output
path. The server inserts `["-progress", "pipe:1"]` immediately before that last element:

```
const args = buildArgsArray(schema, tmpFormValues); // see section 4 for tmpFormValues
const withProgress = [...args.slice(0, -1), "-progress", "pipe:1", ...args.slice(-1)];
```

**Known v1 simplification:** this assumes exactly one positional argument, always present,
always last — true for ffmpeg today, not a general rule `buildArgsArray` itself encodes.
A future tool with zero or multiple positional arguments needs this insertion logic
generalized (e.g. by having `buildArgsArray` optionally return the split point, or by
having schemas declare where execution-layer flags like this should be inserted) — flagged
here the same way `argStyle` was flagged for tool #2, not solved now.

## 4. Process lifecycle

- **Cancel has two distinct branches, not one.** Section 1 promises `POST /api/run/:id/cancel`
  works for "a running or queued run" — these are fundamentally different code paths, and
  conflating them is exactly the kind of one-directional state transition this project has
  hit before (the `-crf` reset-with-no-restore bug, the positional-required bypass).
  - **Cancelling a queued run** (no OS process exists yet): remove it from the queue
    entirely and immediately emit a `cancelled` SSE event on its stream. No signal, no
    timeout, no process handle involved — there is nothing to signal. Implemented as a
    queue-removal operation, not a process-lifecycle operation.
  - **Cancelling the currently-running run**: the real SIGINT-then-SIGKILL flow described
    below. This branch only ever applies to the single active run, never to anything
    sitting in the queue.
  - The cancel handler's first job is determining which branch applies — look up the run
    by id in the queue first; if found there, take the queued-removal branch and return
    immediately, never falling through to any signal-sending code. Only if the run isn't
    in the queue (meaning it must be the active one) does SIGINT/SIGKILL logic run at all.
    Implemented naively (e.g. always sending a signal regardless of state), this would
    either do nothing to a queued run, throw trying to signal a process that was never
    spawned, or — worst case — accidentally signal whatever run happens to be active,
    cancelling the wrong job.
- **Cancel (running run):** `SIGINT` first. If the process hasn't exited after a timeout
  (proposed: 5 seconds), escalate to `SIGKILL`. ffmpeg needs `SIGINT` to close output files
  cleanly; `SIGKILL` immediately would risk a corrupted partial output file.
- **Concurrency:** single-run-at-a-time. A second `POST /api/run` while one is active is
  queued, not rejected and not run in parallel.
- **Queue visibility:** queued runs get a real `runId` immediately and an SSE stream that
  starts by emitting a `queued` event with position (e.g. `{ status: "queued", ahead: 2 }`),
  updating as the queue drains, before eventually emitting `started` once its turn comes.
  No silent queuing — per the original plan, someone who queues three runs and walks away
  should see feedback, not wonder if the app hung.
- **tmp-staging mechanism, stated explicitly:** "writes to tmp first" only becomes true if
  the server actually redirects ffmpeg's output path — `buildArgsArray` run on the
  client's `formValues` unmodified would have ffmpeg write directly to the user's real
  final filename, with no staging happening at all. The actual steps:
  1. Before calling `buildArgsArray`, the server clones `formValues`.
  2. It generates a tmp path: a UUID-based filename **preserving the original file
     extension** from the user's requested `output` value (e.g.
     `tmp/3f9a1c2e.mp3` if the user asked for `audio.mp3`) — the extension must be
     preserved because ffmpeg infers the output codec from it (per the schema's own
     `testNote` on the MP3 preset), so silently changing it could change what ffmpeg
     actually produces.
  3. The clone's `output` field is overwritten with this tmp path; `buildArgsArray` runs
     on the **clone**, not the original `formValues` — this is what actually makes ffmpeg
     write to `tmp/` instead of the user's real destination.
  4. On successful exit (code 0), the tmp file is moved/renamed to
     `~/CLIFace/output/<user's original requested filename>`.
  5. On cancellation or non-zero exit, the tmp file is deleted, never exposed to the user
     as a completed output.

## 5. SSE event shape

One `EventSource` connection per run, emitting:
- `{ type: "queued", ahead: number }`
- `{ type: "started" }`
- `{ type: "progress", frame, fps, out_time, speed }` (parsed from `-progress pipe:1`)
- `{ type: "completed", outputPath }`
- `{ type: "cancelled" }`
- `{ type: "error", message }` (non-zero exit, spawn failure, etc.)

## 6. Run history

On `completed`, `cancelled`, or `error`, append one line to `~/CLIFace/history.json`:
`{ tool, timestamp, flagValues, outputPath, status }`. Per the original plan — simple
append-only JSON, no database needed at this scale.

## 7. Out of scope for Milestone 2

- Custom output location picking (still the fixed `~/CLIFace/output/` folder from the
  original plan).
- Any UI work beyond wiring the existing Run button to actually call `POST /api/run` and
  subscribe to the SSE stream — the visual "up next" queue indicator, progress bar, etc.
  can be minimal/plain for now, same fast-and-loose treatment as the rest of the React layer.

## 8. Testing requirements

Unlike the pure functions in `formLogic.ts`, this milestone involves real subprocesses,
so tests can't just assert on a return value — but the core logic that *decides* what to
do (queue-or-run, when to escalate SIGINT→SIGKILL, when to clean up tmp files) should still
be extracted into small, testable units wherever possible, rather than living entirely
inline in Express route handlers. At minimum:
- A pure function deciding queue position/ordering, testable without spawning anything.
- The SIGINT→SIGKILL escalation timer logic, testable with a fake/mocked process object.
- **The two-branch cancel dispatch (new, section 4):** a pure function/lookup deciding
  "is this runId in the queue or is it the active run" needs its own test — queued case
  removes from queue and returns a cancel decision with no signal involved; active case
  returns the SIGINT decision. This is the exact kind of branch that's easy to get backward
  or fall through incorrectly, and it's pure logic with no subprocess needed to test it.
- **Progress-insertion splicing (section 3), no less tested than queue ordering:** the
  `args.slice(0, -1)` / `args.slice(-1)` arithmetic is exactly the kind of off-by-one that's
  silently wrong on an edge case. Test at minimum: a normal array with several flags plus
  one positional (the common case); an array with only the positional element (edge case,
  confirms slicing an array of length 1 doesn't produce something malformed); and — as a
  documented known limitation per section 3's own text — confirm the function's behavior
  (even if "wrong" in the sense of not generalizing) on a schema with zero positional
  arguments, so that limitation is asserted rather than merely described in prose.
- **tmp-path generation and extension preservation (section 4), no less tested than the
  SIGINT timer:** given `"audio.mp3"`, the generated tmp path must end in `.mp3`, not drop
  or mangle the extension. Test at minimum: a normal single-extension filename; a filename
  with multiple dots (e.g. `"my.video.mp4"` — must preserve `.mp4`, not `.video.mp4` or
  truncate at the first dot); and a filename with no extension at all (edge case — decide
  and assert what happens, e.g. no extension appended, rather than leaving it undefined
  behavior discovered later).
- An integration-style test that actually spawns a trivial real command (not ffmpeg itself
  — something fast and always available, e.g. `echo` or a tiny test script) to prove the
  spawn → SSE event → cleanup pipeline works end-to-end at least once, before trusting it
  with real ffmpeg calls.
