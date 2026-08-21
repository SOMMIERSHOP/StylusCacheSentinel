import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the user-config home to a temp dir for this process.
const tmpHome = path.join(
  os.tmpdir(),
  `sentinel-home-${process.pid}-${Date.now()}`
);
process.env.SENTINEL_HOME = tmpHome;

import {
  initConfig,
  loadConfig,
  saveConfig,
  configExists,
  validateConfig,
  applyConfigSet,
  DEFAULT_CONFIG,
  type UserConfig,
} from "../src/cli/userConfig";
import { classifyInput } from "../src/codehash";
import { chainForId } from "../src/provider";
import { arbitrum, arbitrumNova, arbitrumSepolia } from "viem/chains";

const ADDR = ("0x" + "cd".repeat(20)) as `0x${string}`;
const CODEHASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const RPC = "https://example-orbit.invalid/rpc";

test("classifyInput distinguishes program, codehash, and junk", () => {
  const a = classifyInput(ADDR);
  assert.equal(a?.kind, "program");

  const c = classifyInput(CODEHASH);
  assert.equal(c?.kind, "codehash");

  assert.equal(classifyInput("not-hex"), null);
  assert.equal(classifyInput("0x1234"), null);
});

test("init writes a valid default config", () => {
  assert.equal(configExists(), false);
  const cfg = initConfig();
  assert.equal(configExists(), true);
  assert.deepEqual(validateConfig(cfg), []);
  const reloaded = loadConfig();
  assert.equal(reloaded.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs);
});

test("applyConfigSet validates and applies typed values", () => {
  const cfg = loadConfig();

  const next = applyConfigSet(cfg, "pollIntervalMs", "8000");
  assert.equal(next.pollIntervalMs, 8000);

  const next2 = applyConfigSet(next, "defaultPolicy.maxBidEth", "0.02");
  assert.equal(next2.defaultPolicy.maxBidEth, "0.02");

  const next3 = applyConfigSet(next2, "haltOnDrift", "true");
  assert.equal(next3.haltOnDrift, true);

  // bad ETH value rejected
  assert.throws(() => applyConfigSet(cfg, "defaultPolicy.maxBidEth", "abc"));
  // non-integer interval rejected
  assert.throws(() => applyConfigSet(cfg, "pollIntervalMs", "1.5"));
  // unknown key rejected
  assert.throws(() => applyConfigSet(cfg, "nope", "x"));
});

test("validateConfig rejects malformed watch targets", () => {
  const bothSet: UserConfig = {
    ...DEFAULT_CONFIG,
    watchlist: [{ program: ADDR, codehash: CODEHASH }],
  };
  assert.ok(validateConfig(bothSet).some((e) => e.includes("exactly one")));

  const neither: UserConfig = {
    ...DEFAULT_CONFIG,
    watchlist: [{}],
  };
  assert.ok(validateConfig(neither).some((e) => e.includes("exactly one")));

  const good: UserConfig = {
    ...DEFAULT_CONFIG,
    watchlist: [{ program: ADDR, label: "mine" }],
  };
  assert.deepEqual(validateConfig(good), []);
});

test("saveConfig refuses invalid config", () => {
  const bad = { ...DEFAULT_CONFIG, pollIntervalMs: -1 } as UserConfig;
  assert.throws(() => saveConfig(bad));
});

test("rpcUrl must be a real URL scheme", () => {
  const cfg = loadConfig();
  assert.throws(() => applyConfigSet(cfg, "rpcUrl", "garbage"));
  const ok = applyConfigSet(cfg, "rpcUrl", "https://arb1.arbitrum.io/rpc");
  assert.equal(ok.rpcUrl, "https://arb1.arbitrum.io/rpc");
});

test("headroomPercent is bounded", () => {
  const cfg = loadConfig();
  assert.throws(() => applyConfigSet(cfg, "defaultPolicy.headroomPercent", "100000"));
  const ok = applyConfigSet(cfg, "defaultPolicy.headroomPercent", "50");
  assert.equal(ok.defaultPolicy.headroomPercent, 50);
});

test("bidCooldownSeconds is a positive integer", () => {
  const cfg = loadConfig();
  assert.throws(() => applyConfigSet(cfg, "bidCooldownSeconds", "0"));
  const ok = applyConfigSet(cfg, "bidCooldownSeconds", "120");
  assert.equal(ok.bidCooldownSeconds, 120);
});

// --- chain resolution ------------------------------------------------------
// The chain must follow whatever the RPC serves. Hardcoding Arbitrum One would
// have every Nova/Orbit bid rejected on chain-id validation.

test("chainForId returns viem's definition for known Arbitrum-family chains", () => {
  assert.equal(chainForId(42161, RPC).id, 42161);
  assert.equal(chainForId(42161, RPC).name, arbitrum.name);
  assert.equal(chainForId(42170, RPC).name, arbitrumNova.name);
  assert.equal(chainForId(421614, RPC).name, arbitrumSepolia.name);
});

test("chainForId synthesizes a usable chain for an unknown Orbit id", () => {
  const orbit = chainForId(918_273, RPC);

  assert.equal(orbit.id, 918_273, "must carry the id the RPC reported");
  assert.equal(orbit.nativeCurrency.decimals, 18);
  assert.equal(orbit.nativeCurrency.symbol, "ETH");
  assert.deepEqual(orbit.rpcUrls.default.http, [RPC]);
  // Multicall3 is deployed deterministically; provider still probes for code
  // before enabling batching, so naming it here cannot break a chain without it.
  assert.ok(orbit.contracts?.multicall3?.address);
});

test("chainForId does not confuse one Arbitrum chain for another", () => {
  const ids = [42161, 42170, 421614, 918_273];
  const resolved = ids.map((id) => chainForId(id, RPC).id);
  assert.deepEqual(resolved, ids);
});

test.after(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});
