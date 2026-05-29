import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// DB_PATH must be set before any module that transitively imports config.ts
// — our tsconfig is CJS so statement order is respected at require-time.
const tmpDb = path.join(
  "/tmp",
  `sentinel-test-${process.pid}-${Date.now()}.db`
);
for (const ext of ["", "-wal", "-shm"]) {
  try {
    fs.unlinkSync(tmpDb + ext);
  } catch {}
}
process.env.DB_PATH = tmpDb;

import { encodeEventTopics, encodeAbiParameters, type Log } from "viem";
import { cacheManagerAbi } from "../src/abi";
import { parseEvents } from "../src/indexer/format";
import {
  persistParsedEvents,
  getCurrentlyCached,
  closeDb,
  getBidCount,
  getEvictionCount,
  recordBidAction,
  getSpendWeiSince,
  type ParsedBid,
  type ParsedEviction,
} from "../src/db/store";

const CM_ADDR = ("0x" + "11".repeat(20)) as `0x${string}`;
const BLOCK_HASH = ("0x" + "bb".repeat(32)) as `0x${string}`;

function txHash(n: number): `0x${string}` {
  return ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;
}

test("parseEvents decodes InsertBid, DeleteBid, SetDecayRate, Pause", () => {
  const codehash = ("0x" + "ab".repeat(32)) as `0x${string}`;
  const program = ("0x" + "cd".repeat(20)) as `0x${string}`;

  const insertTopics = encodeEventTopics({
    abi: cacheManagerAbi,
    eventName: "InsertBid",
    args: { codehash },
  });
  const insertData = encodeAbiParameters(
    [{ type: "address" }, { type: "uint192" }, { type: "uint64" }],
    [program, 1_000_000_000n, 4096n]
  );

  const deleteTopics = encodeEventTopics({
    abi: cacheManagerAbi,
    eventName: "DeleteBid",
    args: { codehash },
  });
  const deleteData = encodeAbiParameters(
    [{ type: "uint192" }, { type: "uint64" }],
    [500_000_000n, 4096n]
  );

  const decayTopics = encodeEventTopics({
    abi: cacheManagerAbi,
    eventName: "SetDecayRate",
  });
  const decayData = encodeAbiParameters([{ type: "uint64" }], [12345n]);

  const pauseTopics = encodeEventTopics({
    abi: cacheManagerAbi,
    eventName: "Pause",
  });

  const logs = [
    {
      address: CM_ADDR,
      topics: insertTopics,
      data: insertData,
      blockNumber: 100n,
      transactionHash: txHash(1),
      logIndex: 0,
      blockHash: BLOCK_HASH,
      transactionIndex: 0,
      removed: false,
    },
    {
      address: CM_ADDR,
      topics: deleteTopics,
      data: deleteData,
      blockNumber: 200n,
      transactionHash: txHash(2),
      logIndex: 1,
      blockHash: BLOCK_HASH,
      transactionIndex: 0,
      removed: false,
    },
    {
      address: CM_ADDR,
      topics: decayTopics,
      data: decayData,
      blockNumber: 150n,
      transactionHash: txHash(3),
      logIndex: 0,
      blockHash: BLOCK_HASH,
      transactionIndex: 0,
      removed: false,
    },
    {
      address: CM_ADDR,
      topics: pauseTopics,
      data: "0x" as const,
      blockNumber: 180n,
      transactionHash: txHash(4),
      logIndex: 0,
      blockHash: BLOCK_HASH,
      transactionIndex: 0,
      removed: false,
    },
  ] as unknown as Log[];

  const timestamps = new Map<number, number>([
    [100, 1_700_000_100],
    [150, 1_700_000_150],
    [180, 1_700_000_180],
    [200, 1_700_000_200],
  ]);

  const parsed = parseEvents(logs, timestamps);

  assert.equal(parsed.bids.length, 1, "one InsertBid expected");
  assert.equal(parsed.bids[0].codehash.toLowerCase(), codehash);
  assert.equal(parsed.bids[0].program.toLowerCase(), program);
  assert.equal(parsed.bids[0].bidWei, "1000000000");
  assert.equal(parsed.bids[0].size, 4096);
  assert.equal(parsed.bids[0].blockNumber, 100);
  assert.equal(parsed.bids[0].timestamp, 1_700_000_100);
  assert.equal(parsed.bids[0].logIndex, 0);

  assert.equal(parsed.evictions.length, 1, "one DeleteBid expected");
  assert.equal(parsed.evictions[0].bidWei, "500000000");
  assert.equal(parsed.evictions[0].size, 4096);
  assert.equal(parsed.evictions[0].blockNumber, 200);

  assert.equal(parsed.configEvents.length, 2, "SetDecayRate + Pause expected");
  const decay = parsed.configEvents.find((c) => c.eventType === "SetDecayRate");
  const pause = parsed.configEvents.find((c) => c.eventType === "Pause");
  assert.ok(decay, "decay event present");
  assert.equal(decay!.value, "12345");
  assert.ok(pause, "pause event present");
  assert.equal(pause!.value, null);
});

test("getCurrentlyCached handles bid, evict, and rebid scenarios", () => {
  // A: bid → evict → rebid → should be cached at rebid size
  // B: bid only → should be cached at original size
  // C: bid → evict → should NOT be cached
  const codeA = ("0x" + "a1".repeat(32)) as `0x${string}`;
  const codeB = ("0x" + "b2".repeat(32)) as `0x${string}`;
  const codeC = ("0x" + "c3".repeat(32)) as `0x${string}`;
  const prog = ("0x" + "de".repeat(20)) as `0x${string}`;

  const bid = (
    codehash: `0x${string}`,
    blockNumber: number,
    tx: number,
    size: number,
    bidWei: string
  ): ParsedBid => ({
    codehash,
    program: prog,
    bidWei,
    size,
    blockNumber,
    txHash: txHash(tx),
    logIndex: 0,
    timestamp: blockNumber,
  });

  const evict = (
    codehash: `0x${string}`,
    blockNumber: number,
    tx: number,
    size: number,
    bidWei: string
  ): ParsedEviction => ({
    codehash,
    bidWei,
    size,
    blockNumber,
    txHash: txHash(tx),
    logIndex: 0,
    timestamp: blockNumber,
  });

  persistParsedEvents([bid(codeA, 100, 1, 1000, "100")], [], [], 100);
  persistParsedEvents([bid(codeB, 110, 2, 2000, "200")], [], [], 110);
  persistParsedEvents([bid(codeC, 120, 3, 3000, "300")], [], [], 120);
  persistParsedEvents([], [evict(codeA, 150, 4, 1000, "100")], [], 150);
  persistParsedEvents([], [evict(codeC, 160, 5, 3000, "300")], [], 160);
  persistParsedEvents([bid(codeA, 200, 6, 1500, "400")], [], [], 200);

  const cached = getCurrentlyCached();
  const map = new Map(cached.map((c) => [c.codehash.toLowerCase(), c.size]));

  assert.equal(cached.length, 2, "expected 2 currently-cached entries");
  assert.equal(
    map.get(codeA.toLowerCase()),
    1500,
    "A cached at rebid size"
  );
  assert.equal(
    map.get(codeB.toLowerCase()),
    2000,
    "B cached at original size"
  );
  assert.ok(
    !map.has(codeC.toLowerCase()),
    "C must not be cached after eviction"
  );

  const totalBidSize = cached.reduce((acc, c) => acc + c.size, 0);
  assert.equal(totalBidSize, 3500, "derived queue size = A(1500) + B(2000)");

  assert.equal(getBidCount(), 4, "4 bids stored (3 initial + 1 rebid)");
  assert.equal(getEvictionCount(), 2, "2 evictions stored");

  // idempotency: replaying the rebid must be dedup'd
  const dup = persistParsedEvents(
    [bid(codeA, 200, 6, 1500, "400")],
    [],
    [],
    200
  );
  assert.equal(dup.bidsInserted, 0);
  assert.equal(dup.bidsSkipped, 1);
  assert.equal(getBidCount(), 4, "bid count unchanged after replay");
});

test("getSpendWeiSince counts dry-run rows only when asked (NEW-6 preview)", () => {
  const ch = ("0x" + "e5".repeat(32)) as `0x${string}`;
  recordBidAction({ codehash: ch, program: null, bidWei: "1000", status: "submitted", txHash: null, reason: "live" });
  recordBidAction({ codehash: ch, program: null, bidWei: "500", status: "dry-run", txHash: null, reason: "sim" });

  const live = getSpendWeiSince(0);
  const withDry = getSpendWeiSince(0, { includeDryRun: true });
  assert.equal(withDry - live, 500n, "dry-run row only counted when includeDryRun is set");
});

test.after(() => {
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(tmpDb + ext);
    } catch {}
  }
});
