/**
 * Zero-dependency CLI flag/positional parser.
 *
 * Cross-platform (no shell assumptions) — used by src/index.ts to split
 * `process.argv` into positional arguments and `--flag` options.
 *
 * @module
 */

// Tiny zero-dependency flag parser. Cross-platform (no shell assumptions).
// Supports: `--key value`, `--key=value`, and boolean `--flag`.
/** Result of {@link parseArgs}: positional arguments plus parsed `--flag` values. */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Split a raw argv slice into positionals and flags.
 *
 * Supports `--key value`, `--key=value`, and boolean `--flag` (a flag with
 * no following value, or one followed by another `--flag`, is `true`).
 *
 * @param argv — argument list to parse (typically `process.argv.slice(3)`, i.e. after the command name)
 * @returns the parsed positionals and flags
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

/**
 * Read a flag as a string value, ignoring boolean flags.
 *
 * @param flags — parsed flags map (from {@link ParsedArgs})
 * @param key — flag name, without the `--` prefix
 * @returns the string value, or `undefined` if unset or set as a bare boolean flag
 */
export function flagString(
  flags: Record<string, string | boolean>,
  key: string
): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Read a flag as a boolean. Treats both a bare `--flag` and `--flag=true`
 * (or `--flag true`) as true; anything else (including unset) is false.
 *
 * @param flags — parsed flags map (from {@link ParsedArgs})
 * @param key — flag name, without the `--` prefix
 * @returns whether the flag is set truthy
 */
export function flagBool(
  flags: Record<string, string | boolean>,
  key: string
): boolean {
  return flags[key] === true || flags[key] === "true";
}
