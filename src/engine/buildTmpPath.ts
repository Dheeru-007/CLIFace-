import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Generates a tmp staging path for a run's output, preserving the original file
 * extension — ffmpeg infers its output codec from the extension (per the schema's own
 * testNote on the MP3 preset), so silently dropping or mangling it here would silently
 * change what ffmpeg actually produces.
 *
 * Edge cases, decided explicitly rather than left as undefined behavior:
 *  - Multi-dot filenames ("my.video.mp4") preserve only the LAST extension (".mp4"),
 *    matching how ffmpeg/most tools interpret "the extension" — not everything after the
 *    first dot.
 *  - A filename with no extension at all produces a tmp path with no extension either —
 *    nothing is invented or assumed on the caller's behalf.
 *
 * `tmpDir` is passed in (not hardcoded) so this stays a pure, easily-testable function —
 * the caller decides the real tmp directory location.
 */
export function buildTmpPath(originalFilename: string, tmpDir: string): string {
  const ext = path.extname(originalFilename); // "" if no dot, or the LAST extension only
  return path.join(tmpDir, `${randomUUID()}${ext}`);
}
