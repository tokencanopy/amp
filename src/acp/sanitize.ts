/**
 * Everything an agent process writes is untrusted output that ends up in a
 * browser and in the database. Two things must not survive that trip: ANSI
 * escape sequences (which move the cursor, clear the screen, and in some
 * terminals set the window title) and raw control characters. Both are
 * stripped here, once, at the boundary.
 *
 * The patterns are built from character codes rather than written as literal
 * escapes so that this source file contains no control bytes of its own.
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** CSI sequences and OSC strings — the two forms adapters actually emit. */
const ANSI = new RegExp(
  [
    `${ESC}\\[[0-9;?]*[ -/]*[@-~]`,
    `${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[@-Z\\\\-_]`,
  ].join("|"),
  "gu",
);

export const MAX_LOG_LINE = 2_000;
export const MAX_TEXT = 100_000;

/** Keep newline and tab; drop every other C0/C1 control and DEL. */
function stripControls(input: string): string {
  let out = "";
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    const keep =
      code === 0x0a ||
      code === 0x09 ||
      (code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f));
    if (keep) out += character;
  }
  return out;
}

export function sanitizeText(input: string, limit = MAX_TEXT): string {
  const cleaned = stripControls(input.replace(ANSI, ""));
  return cleaned.length > limit
    ? `${cleaned.slice(0, limit)}… [truncated ${cleaned.length - limit} chars]`
    : cleaned;
}

/** One diagnostic line: sanitized, collapsed to a single line, and capped. */
export function sanitizeLogLine(input: string): string {
  return sanitizeText(input.replace(/[\n\t]+/gu, " "), MAX_LOG_LINE).trim();
}

/**
 * A bounded ring of diagnostic lines. Diagnostics cover the last few minutes
 * of a live meeting, not an archive — an unbounded buffer is a slow memory
 * leak with a browser payload attached.
 */
export class BoundedLog {
  #lines: { at: string; line: string }[] = [];
  readonly #limit: number;

  constructor(limit = 500) {
    this.#limit = limit;
  }

  push(line: string): { at: string; line: string } {
    const record = {
      at: new Date().toISOString(),
      line: sanitizeLogLine(line),
    };
    this.#lines.push(record);
    if (this.#lines.length > this.#limit) {
      this.#lines.splice(0, this.#lines.length - this.#limit);
    }
    return record;
  }

  all(): readonly { at: string; line: string }[] {
    return [...this.#lines];
  }
}
