/**
 * Inserts ["-progress", "pipe:1"] immediately before the last element of a buildArgsArray
 * result, rather than appending it at the very end. Real ffmpeg requires output-related
 * options like -progress to appear BEFORE the output filename — buildArgsArray's own
 * contract guarantees positional args (i.e. `output`) are always last, so naively pushing
 * onto the end would land -progress AFTER output, which ffmpeg rejects or ignores.
 *
 * v1 known simplification (stated explicitly, not silently assumed): this assumes exactly
 * one positional argument, always present, always last — true for ffmpeg today because
 * Run is only reachable once canBuildArgs confirms the required `output` field resolves.
 *
 * The real risk this does NOT generalize to is more specific than "an empty array": a
 * schema with ZERO positional fields still produces a non-empty buildArgsArray result —
 * ordinary flag-value pairs like ["-i", "input.mp4", "-b:a", "192k"]. This function has no
 * way to distinguish "the last element is a lone positional argument" from "the last
 * element is some flag's value" — it always assumes the former. Given the second array
 * above, it would slice off "192k" as if it were a positional filename and splice
 * -progress/pipe:1 in front of it, silently separating -b:a from its own value. This is a
 * genuine corruption case, not just a fallback — see the dedicated test documenting this
 * exact input/output, so a future tool with zero positional fields has a concrete failing
 * test to fix rather than rediscovering this by shipping it.
 */
export function insertProgressFlag(args: string[]): string[] {
  if (args.length === 0) {
    // No positional argument to insert before at all — nothing meaningful to splice into.
    // Documented limitation: this function assumes a schema with at least one positional
    // arg (true for ffmpeg's `output`); a zero-positional schema isn't supported by this
    // insertion strategy and would need different handling, not silently "fixed" here.
    return ["-progress", "pipe:1"];
  }

  return [...args.slice(0, -1), "-progress", "pipe:1", ...args.slice(-1)];
}
