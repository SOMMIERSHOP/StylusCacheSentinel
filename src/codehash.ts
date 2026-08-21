/**
 * Resolves a raw user-supplied target (program address or codehash) into a
 * concrete CacheManager codehash.
 *
 * CacheManager keys everything on codehash, but users naturally think in
 * program addresses, so this module bridges the two: it maps program ->
 * codehash via the indexer DB first, falling back to on-chain account code
 * when the DB has no record.
 *
 * @module
 */

import { getAddress, isAddress, isHex, keccak256 } from "viem";
import { getClient } from "./provider";
import { getCodehashForProgram, getProgramForCodehash } from "./db/store";

// A watch/inspect/bid target is identified either by the Stylus program
// address or directly by its codehash (what CacheManager actually keys on).
/** A raw CLI target, classified as either a program address or a codehash. */
export type TargetInput =
  | { kind: "program"; program: `0x${string}` }
  | { kind: "codehash"; codehash: `0x${string}` };

// Classify a raw CLI string. 20-byte hex -> program address, 32-byte hex ->
// codehash. Pure (no chain / DB), so it is unit-testable on its own.
/**
 * Classify a raw CLI string as a program address or a codehash by hex length.
 * Pure (no chain / DB access), so it is unit-testable on its own.
 *
 * @param raw — user-supplied string, e.g. a CLI positional argument
 * @returns the classified {@link TargetInput}, or `null` if `raw` is neither a valid 20-byte address nor a 32-byte hex codehash
 */
export function classifyInput(raw: string): TargetInput | null {
  const trimmed = raw.trim();
  if (isAddress(trimmed)) {
    return { kind: "program", program: getAddress(trimmed) };
  }
  if (isHex(trimmed) && trimmed.length === 66) {
    return { kind: "codehash", codehash: trimmed.toLowerCase() as `0x${string}` };
  }
  return null;
}

/** A target fully resolved to its codehash, with the program address if known. */
export interface ResolvedTarget {
  codehash: `0x${string}`;
  program: `0x${string}` | null;
}

// Resolve a classified target down to a concrete codehash (+ program if known).
// For a program we try the indexer DB first (cheap, exact), then fall back to
// the on-chain account code hash. For a bare codehash we attempt a reverse
// program lookup for display only.
/**
 * Resolve a classified target down to a concrete codehash (+ program address
 * if known). For a `program` input, tries the indexer DB first (cheap,
 * exact), then falls back to hashing the on-chain account code. For a
 * `codehash` input, attempts a reverse program lookup for display only (the
 * codehash itself needs no resolution).
 *
 * @param input — a classified target (see {@link classifyInput})
 * @returns the resolved codehash and, if known, the associated program address
 * @throws if given a program with no DB record and no deployed code on-chain
 */
export async function resolveTarget(
  input: TargetInput
): Promise<ResolvedTarget> {
  if (input.kind === "codehash") {
    return { codehash: input.codehash, program: getProgramForCodehash(input.codehash) };
  }

  const fromDb = getCodehashForProgram(input.program);
  if (fromDb) {
    return { codehash: fromDb, program: input.program };
  }

  // Fallback: derive the codehash from the deployed account code. For an
  // activated Stylus program this matches the codehash CacheManager emits.
  const code = await getClient().getCode({ address: input.program });
  if (!code || code === "0x") {
    throw new Error(
      `No bid history in the indexer for ${input.program} and the address has no code on-chain. ` +
        `Provide the codehash directly, or run \`sentinel sync\` first.`
    );
  }
  return { codehash: keccak256(code), program: input.program };
}

// Convenience: classify + resolve in one step, with a friendly error.
/**
 * Classify and resolve a raw CLI string in one step, the entry point used by
 * `inspect`, `bid`, and other commands that accept `<program|codehash>`.
 *
 * @param raw — user-supplied string, e.g. a CLI positional argument
 * @returns the resolved target
 * @throws if `raw` is not a valid address/codehash, or if resolution fails (see {@link resolveTarget})
 */
export async function resolveRawTarget(raw: string): Promise<ResolvedTarget> {
  const input = classifyInput(raw);
  if (!input) {
    throw new Error(
      `"${raw}" is not a valid program address (20-byte hex) or codehash (32-byte hex).`
    );
  }
  return resolveTarget(input);
}
