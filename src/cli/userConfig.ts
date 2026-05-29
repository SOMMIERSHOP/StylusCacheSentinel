import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAddress, isHex, parseEther } from "viem";

// Per-user configuration for the sentinel automation layer (M3). Stored as
// JSON under ~/.sentinel (override the home dir with SENTINEL_HOME, which the
// test suite uses for isolation). Everything here is validated before use so
// the CLI can guarantee "100% of configurations correctly applied" (M3 KPI).

export interface BidPolicy {
  // Hard ceiling for a single bid, in ETH (string to preserve precision).
  maxBidEth: string;
  // Target margin above the on-chain minimum bid, as a percentage.
  headroomPercent: number;
}

export interface WatchTarget {
  // Exactly one of program / codehash is set, plus optional overrides.
  program?: `0x${string}`;
  codehash?: `0x${string}`;
  label?: string;
  maxBidEth?: string;
  headroomPercent?: number;
}

export interface UserConfig {
  // Optional RPC override; falls back to ARB_RPC_URL / default when unset.
  rpcUrl?: string;
  // Sentinel loop tick in ms (bounds cache-expiration detection latency).
  pollIntervalMs: number;
  defaultPolicy: BidPolicy;
  // Per-window spend cap (fail-safe) and the window length in hours.
  maxSpendPerWindowEth: string;
  spendWindowHours: number;
  // Refuse to bid while the DB-vs-chain reconcile reports drift.
  haltOnDrift: boolean;
  // Minimum seconds between bid actions on the same target (anti-spam / anti
  // duplicate-submit).
  bidCooldownSeconds: number;
  watchlist: WatchTarget[];
}

// Sanity ceiling for headroom — a percentage over the min bid. Bounded so a
// fat-fingered `config set ... 100000` can't slip past validation (the per-bid
// cap is the only other guard).
export const MAX_HEADROOM_PERCENT = 10_000;

export const DEFAULT_CONFIG: UserConfig = {
  pollIntervalMs: 5000,
  defaultPolicy: { maxBidEth: "0.01", headroomPercent: 20 },
  maxSpendPerWindowEth: "0.05",
  spendWindowHours: 24,
  haltOnDrift: false,
  bidCooldownSeconds: 300,
  watchlist: [],
};

export function sentinelHome(): string {
  return process.env.SENTINEL_HOME || path.join(os.homedir(), ".sentinel");
}

export function configPath(): string {
  return path.join(sentinelHome(), "config.json");
}

export function configExists(): boolean {
  return fs.existsSync(configPath());
}

// Defensively read just the rpcUrl override from the config file without
// running full validation — used at CLI startup to point the clients at a
// custom endpoint (e.g. an Orbit chain). Never throws: a missing/corrupt
// config or an invalid scheme simply yields null (env/default is used).
export function readConfigRpcUrl(): string | null {
  try {
    if (!configExists()) return null;
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const url = raw?.rpcUrl;
    if (typeof url === "string" && /^(https?|wss?):\/\//.test(url)) return url;
  } catch {
    /* ignore — fall back to env/default */
  }
  return null;
}

export function loadConfig(): UserConfig {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `No config found at ${p}. Run \`sentinel config init\` first.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  // Merge over defaults so older config files still load as new fields appear.
  const merged: UserConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    defaultPolicy: { ...DEFAULT_CONFIG.defaultPolicy, ...(raw.defaultPolicy ?? {}) },
    watchlist: Array.isArray(raw.watchlist) ? raw.watchlist : [],
  };
  const errors = validateConfig(merged);
  if (errors.length > 0) {
    throw new Error(`Invalid config at ${p}:\n  - ${errors.join("\n  - ")}`);
  }
  return merged;
}

export function saveConfig(cfg: UserConfig): void {
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    throw new Error(`Refusing to save invalid config:\n  - ${errors.join("\n  - ")}`);
  }
  const dir = sentinelHome();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}

export function initConfig(force = false): UserConfig {
  if (configExists() && !force) {
    throw new Error(
      `Config already exists at ${configPath()}. Use --force to overwrite.`
    );
  }
  const cfg = structuredCloneConfig(DEFAULT_CONFIG);
  saveConfig(cfg);
  return cfg;
}

function structuredCloneConfig(cfg: UserConfig): UserConfig {
  return JSON.parse(JSON.stringify(cfg));
}

// ---- validation ----------------------------------------------------------

function isPositiveInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isEthString(v: unknown): boolean {
  if (typeof v !== "string" || v.trim() === "") return false;
  try {
    parseEther(v as `${number}`);
    return true;
  } catch {
    return false;
  }
}

export function validateConfig(cfg: UserConfig): string[] {
  const errors: string[] = [];

  if (!isPositiveInt(cfg.pollIntervalMs)) {
    errors.push("pollIntervalMs must be a positive integer (ms)");
  }
  if (cfg.rpcUrl !== undefined) {
    if (typeof cfg.rpcUrl !== "string" || !/^(https?|wss?):\/\//.test(cfg.rpcUrl)) {
      errors.push("rpcUrl must be an http(s):// or ws(s):// URL");
    }
  }
  if (!isEthString(cfg.maxSpendPerWindowEth)) {
    errors.push("maxSpendPerWindowEth must be a decimal ETH string");
  }
  if (!isPositiveInt(cfg.spendWindowHours)) {
    errors.push("spendWindowHours must be a positive integer");
  }
  if (!isPositiveInt(cfg.bidCooldownSeconds)) {
    errors.push("bidCooldownSeconds must be a positive integer");
  }
  if (typeof cfg.haltOnDrift !== "boolean") {
    errors.push("haltOnDrift must be a boolean");
  }

  errors.push(...validatePolicy(cfg.defaultPolicy, "defaultPolicy"));

  if (!Array.isArray(cfg.watchlist)) {
    errors.push("watchlist must be an array");
  } else {
    cfg.watchlist.forEach((t, i) => {
      errors.push(...validateTarget(t, `watchlist[${i}]`));
    });
  }

  return errors;
}

function validatePolicy(p: BidPolicy | undefined, label: string): string[] {
  const errors: string[] = [];
  if (!p) {
    errors.push(`${label} is required`);
    return errors;
  }
  if (!isEthString(p.maxBidEth)) {
    errors.push(`${label}.maxBidEth must be a decimal ETH string`);
  }
  if (
    typeof p.headroomPercent !== "number" ||
    !Number.isFinite(p.headroomPercent) ||
    p.headroomPercent < 0 ||
    p.headroomPercent > MAX_HEADROOM_PERCENT
  ) {
    errors.push(
      `${label}.headroomPercent must be a number between 0 and ${MAX_HEADROOM_PERCENT}`
    );
  }
  return errors;
}

function validateTarget(t: WatchTarget, label: string): string[] {
  const errors: string[] = [];
  const hasProgram = typeof t.program === "string";
  const hasCodehash = typeof t.codehash === "string";
  if (hasProgram === hasCodehash) {
    errors.push(`${label} must set exactly one of program / codehash`);
  }
  if (hasProgram && !isAddress(t.program as string)) {
    errors.push(`${label}.program is not a valid address`);
  }
  if (
    hasCodehash &&
    !(isHex(t.codehash as string) && (t.codehash as string).length === 66)
  ) {
    errors.push(`${label}.codehash must be 32-byte hex`);
  }
  if (t.maxBidEth !== undefined && !isEthString(t.maxBidEth)) {
    errors.push(`${label}.maxBidEth must be a decimal ETH string`);
  }
  if (
    t.headroomPercent !== undefined &&
    (typeof t.headroomPercent !== "number" ||
      !Number.isFinite(t.headroomPercent) ||
      t.headroomPercent < 0 ||
      t.headroomPercent > MAX_HEADROOM_PERCENT)
  ) {
    errors.push(
      `${label}.headroomPercent must be a number between 0 and ${MAX_HEADROOM_PERCENT}`
    );
  }
  return errors;
}

// ---- typed setters for `config set <key> <value>` -------------------------

// Returns a parsed/validated copy with the dotted key applied, or throws.
export function applyConfigSet(
  cfg: UserConfig,
  key: string,
  rawValue: string
): UserConfig {
  const next = structuredCloneConfig(cfg);
  switch (key) {
    case "rpcUrl":
      next.rpcUrl = rawValue;
      break;
    case "pollIntervalMs":
      next.pollIntervalMs = parseIntStrict(rawValue, key);
      break;
    case "maxSpendPerWindowEth":
      next.maxSpendPerWindowEth = rawValue;
      break;
    case "spendWindowHours":
      next.spendWindowHours = parseIntStrict(rawValue, key);
      break;
    case "bidCooldownSeconds":
      next.bidCooldownSeconds = parseIntStrict(rawValue, key);
      break;
    case "haltOnDrift":
      next.haltOnDrift = parseBoolStrict(rawValue, key);
      break;
    case "defaultPolicy.maxBidEth":
      next.defaultPolicy.maxBidEth = rawValue;
      break;
    case "defaultPolicy.headroomPercent":
      next.defaultPolicy.headroomPercent = parseNumberStrict(rawValue, key);
      break;
    default:
      throw new Error(
        `Unknown config key "${key}". Settable keys: rpcUrl, pollIntervalMs, ` +
          `maxSpendPerWindowEth, spendWindowHours, bidCooldownSeconds, haltOnDrift, ` +
          `defaultPolicy.maxBidEth, defaultPolicy.headroomPercent`
      );
  }
  const errors = validateConfig(next);
  if (errors.length > 0) {
    throw new Error(`Value rejected:\n  - ${errors.join("\n  - ")}`);
  }
  return next;
}

function parseIntStrict(v: string, key: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${key} must be an integer`);
  return n;
}
function parseNumberStrict(v: string, key: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}
function parseBoolStrict(v: string, key: string): boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`${key} must be "true" or "false"`);
}
