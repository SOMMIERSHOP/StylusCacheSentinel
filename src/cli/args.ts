// Tiny zero-dependency flag parser. Cross-platform (no shell assumptions).
// Supports: `--key value`, `--key=value`, and boolean `--flag`.
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

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

export function flagString(
  flags: Record<string, string | boolean>,
  key: string
): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(
  flags: Record<string, string | boolean>,
  key: string
): boolean {
  return flags[key] === true || flags[key] === "true";
}
