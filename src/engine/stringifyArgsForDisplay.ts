/**
 * Converts a binary name and its args array into a human-readable command string.
 *
 * Rules (display-only — not intended for shell eval):
 *  - Args with no whitespace are joined as-is.
 *  - Args containing whitespace are wrapped in double quotes.
 *  - Inside a quoted arg, backslashes and double quotes are escaped ( \\ and \" ).
 */
export function stringifyArgsForDisplay(binary: string, args: string[]): string {
    const tokens = [binary, ...args].map((token) => {
        if (!/\s/.test(token)) {
            return token;
        }
        // Escape backslashes first, then double quotes.
        const escaped = token.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `"${escaped}"`;
    });

    return tokens.join(" ");
}
