/**
 * Local SQLite persistence layer: connection lifecycle, hex/BLOB helpers, sync
 * bookkeeping, idempotent event writes, analytics queries, and bid_actions audit trail.
 *
 * Every exported query/write function lazily obtains the single shared connection via
 * getDb(). Fact-table writes are idempotent through UNIQUE(tx_hash, log_index), and
 * persistParsedEvents wraps all writes for one batch in a single transaction so a
 * partial failure never leaves bids/evictions/config_events/sync_meta inconsistent.
 *
 * @module
 */

import Database from "better-sqlite3";
import { config } from "../config";
import { initSchema } from "./schema";

let _db: Database.Database | null = null;

/**
 * Get the process-wide SQLite connection, opening and initializing it on first call.
 *
 * Sets WAL journaling, NORMAL synchronous mode, and enforces foreign keys, then runs
 * initSchema (which may drop/recreate tables on a version mismatch). Subsequent calls
 * return the cached connection.
 *
 * @returns The shared better-sqlite3 database handle.
 */
export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

/** Close the shared connection if open and clear the cached handle, so a subsequent getDb() reopens fresh. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Convert a `0x`-prefixed (or bare) hex string to a Buffer for BLOB storage.
 *
 * @param hex - Hex string, with or without `0x` prefix.
 * @returns Raw bytes.
 */
export function hexToBuf(hex: string): Buffer {
  return Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
}

/**
 * Convert a BLOB column's raw bytes back to a `0x`-prefixed hex string.
 *
 * @param buf - Bytes read from a BLOB column.
 * @returns Lowercase `0x`-prefixed hex string.
 */
export function bufToHex(buf: Buffer | Uint8Array): `0x${string}` {
  return ("0x" + Buffer.from(buf).toString("hex")) as `0x${string}`;
}

// sync_meta

/**
 * Read the last block number the indexer fully synced through.
 *
 * @returns The stored block number, or null if nothing has been synced yet.
 */
export function getLastSyncedBlock(): number | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM sync_meta WHERE key = ?")
    .get("last_block") as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : null;
}

/**
 * Persist the last block number synced. Upserts the `last_block` key in sync_meta.
 *
 * @param block - Block number to record as fully synced.
 */
export function setLastSyncedBlock(block: number): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run("last_block", block.toString());
}

/**
 * Upsert an arbitrary key/value pair in sync_meta, for indexer bookkeeping beyond
 * `last_block` (e.g. gap-detection cursors).
 *
 * @param key - Meta key to set.
 * @param value - Value to store (always TEXT).
 */
export function setSyncMeta(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

/**
 * Read an arbitrary sync_meta value by key.
 *
 * @param key - Meta key to read.
 * @returns The stored value, or null if unset.
 */
export function getSyncMeta(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM sync_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

// parsed row shapes — produced by format.ts, consumed here

/** Decoded InsertBid event, ready to persist. */
export interface ParsedBid {
  codehash: `0x${string}`;
  program: `0x${string}`;
  bidWei: string;
  size: number;
  blockNumber: number;
  txHash: `0x${string}`;
  logIndex: number;
  timestamp: number;
}

/** Decoded DeleteBid/eviction event, ready to persist. */
export interface ParsedEviction {
  codehash: `0x${string}`;
  bidWei: string;
  size: number;
  blockNumber: number;
  txHash: `0x${string}`;
  logIndex: number;
  timestamp: number;
}

/** Decoded CacheManager config-change event (cache size, decay rate, pause state), ready to persist. */
export interface ParsedConfigEvent {
  eventType: "SetCacheSize" | "SetDecayRate" | "Pause" | "Unpause";
  value: string | null;
  blockNumber: number;
  txHash: `0x${string}`;
  logIndex: number;
  timestamp: number;
}

/** Per-table insert/skip counts returned by persistParsedEvents, for logging and backfill progress reporting. */
export interface PersistResult {
  bidsInserted: number;
  bidsSkipped: number;
  evictionsInserted: number;
  evictionsSkipped: number;
  configInserted: number;
  configSkipped: number;
}

// dim upserts — return program/codehash id, caching within a batch

class IdCache {
  private programs = new Map<string, number>();
  private codehashes = new Map<string, number>();
  getProgram(hex: string): number | undefined {
    return this.programs.get(hex.toLowerCase());
  }
  setProgram(hex: string, id: number): void {
    this.programs.set(hex.toLowerCase(), id);
  }
  getCodehash(hex: string): number | undefined {
    return this.codehashes.get(hex.toLowerCase());
  }
  setCodehash(hex: string, id: number): void {
    this.codehashes.set(hex.toLowerCase(), id);
  }
}

function upsertProgram(
  db: Database.Database,
  cache: IdCache,
  address: `0x${string}`,
  block: number,
  ts: number
): number {
  const cached = cache.getProgram(address);
  if (cached !== undefined) return cached;

  const buf = hexToBuf(address);
  db.prepare(
    `INSERT OR IGNORE INTO programs (address, first_seen_block, first_seen_ts)
     VALUES (?, ?, ?)`
  ).run(buf, block, ts);
  const row = db
    .prepare("SELECT id FROM programs WHERE address = ?")
    .get(buf) as { id: number };
  cache.setProgram(address, row.id);
  return row.id;
}

function upsertCodehash(
  db: Database.Database,
  cache: IdCache,
  codehash: `0x${string}`,
  programId: number | null,
  size: number | null,
  block: number,
  ts: number
): number {
  const cached = cache.getCodehash(codehash);
  if (cached !== undefined) {
    if (programId !== null || size !== null) {
      db.prepare(
        `UPDATE codehashes
            SET program_id = COALESCE(?, program_id),
                size       = COALESCE(?, size)
          WHERE id = ?`
      ).run(programId, size, cached);
    }
    return cached;
  }

  const buf = hexToBuf(codehash);
  db.prepare(
    `INSERT OR IGNORE INTO codehashes (codehash, program_id, size, first_seen_block, first_seen_ts)
     VALUES (?, ?, ?, ?, ?)`
  ).run(buf, programId, size, block, ts);
  const row = db
    .prepare("SELECT id, program_id, size FROM codehashes WHERE codehash = ?")
    .get(buf) as { id: number; program_id: number | null; size: number | null };

  if (
    (programId !== null && row.program_id !== programId) ||
    (size !== null && row.size !== size)
  ) {
    db.prepare(
      `UPDATE codehashes
          SET program_id = COALESCE(?, program_id),
              size       = COALESCE(?, size)
        WHERE id = ?`
    ).run(programId, size, row.id);
  }

  cache.setCodehash(codehash, row.id);
  return row.id;
}

// fact inserts — idempotent via UNIQUE(tx_hash, log_index)

/**
 * Persist a batch of decoded bid/eviction/config events, upserting their dim-table
 * rows (programs, codehashes) along the way, and advance `last_block` in sync_meta.
 *
 * Idempotent: re-running with overlapping data (e.g. after a re-org or a rerun of
 * backfill) is safe — fact rows are `INSERT OR IGNORE`d against
 * UNIQUE(tx_hash, log_index), so already-seen events are counted as "skipped" rather
 * than duplicated. The entire batch (dim upserts, fact inserts, sync_meta update) runs
 * inside a single transaction, so a failure partway through leaves no partial state.
 *
 * @param bids - Decoded InsertBid events to persist.
 * @param evictions - Decoded eviction events to persist.
 * @param configEvents - Decoded config-change events to persist.
 * @param lastBlockInBatch - Highest block number covered by this batch, written to
 *   `sync_meta.last_block` if non-null; pass null to skip advancing the cursor (e.g.
 *   for out-of-order or partial batches).
 * @returns Insert/skip counts per table.
 */
export function persistParsedEvents(
  bids: ParsedBid[],
  evictions: ParsedEviction[],
  configEvents: ParsedConfigEvent[],
  lastBlockInBatch: number | null
): PersistResult {
  const db = getDb();
  const cache = new IdCache();

  const bidStmt = db.prepare(
    `INSERT OR IGNORE INTO bids
       (codehash_id, program_id, bid_wei, size, block_number, tx_hash, log_index, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const evictionStmt = db.prepare(
    `INSERT OR IGNORE INTO evictions
       (codehash_id, bid_wei, size, block_number, tx_hash, log_index, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const configStmt = db.prepare(
    `INSERT OR IGNORE INTO config_events
       (event_type, value, block_number, tx_hash, log_index, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const metaStmt = db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );

  const result: PersistResult = {
    bidsInserted: 0,
    bidsSkipped: 0,
    evictionsInserted: 0,
    evictionsSkipped: 0,
    configInserted: 0,
    configSkipped: 0,
  };

  const tx = db.transaction(() => {
    for (const b of bids) {
      const programId = upsertProgram(db, cache, b.program, b.blockNumber, b.timestamp);
      const codehashId = upsertCodehash(
        db,
        cache,
        b.codehash,
        programId,
        b.size,
        b.blockNumber,
        b.timestamp
      );
      const info = bidStmt.run(
        codehashId,
        programId,
        b.bidWei,
        b.size,
        b.blockNumber,
        hexToBuf(b.txHash),
        b.logIndex,
        b.timestamp
      );
      if (info.changes > 0) result.bidsInserted++;
      else result.bidsSkipped++;
    }

    for (const e of evictions) {
      const codehashId = upsertCodehash(
        db,
        cache,
        e.codehash,
        null,
        e.size,
        e.blockNumber,
        e.timestamp
      );
      const info = evictionStmt.run(
        codehashId,
        e.bidWei,
        e.size,
        e.blockNumber,
        hexToBuf(e.txHash),
        e.logIndex,
        e.timestamp
      );
      if (info.changes > 0) result.evictionsInserted++;
      else result.evictionsSkipped++;
    }

    for (const c of configEvents) {
      const info = configStmt.run(
        c.eventType,
        c.value,
        c.blockNumber,
        hexToBuf(c.txHash),
        c.logIndex,
        c.timestamp
      );
      if (info.changes > 0) result.configInserted++;
      else result.configSkipped++;
    }

    if (lastBlockInBatch !== null) {
      metaStmt.run("last_block", lastBlockInBatch.toString());
    }
  });

  tx();
  return result;
}

/**
 * Record a block range that could not be fully synced (e.g. RPC gave up, provider
 * gap), for later inspection/backfill. Deduped on the (from_block, to_block) primary
 * key — recording the same range twice is a no-op.
 *
 * @param fromBlock - First block of the unsynced range.
 * @param toBlock - Last block of the unsynced range.
 * @param reason - Short human-readable explanation of why the gap occurred.
 */
export function recordSyncGap(
  fromBlock: number,
  toBlock: number,
  reason: string
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO sync_gaps (from_block, to_block, reason, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(fromBlock, toBlock, reason, Math.floor(Date.now() / 1000));
}

/** A recorded unsynced block range, as read back from sync_gaps. */
export interface SyncGap {
  from_block: number;
  to_block: number;
  reason: string | null;
  recorded_at: number;
}

/**
 * List all recorded sync gaps, oldest range first.
 *
 * @returns All rows in sync_gaps ordered by from_block ascending.
 */
export function listSyncGaps(): SyncGap[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT from_block, to_block, reason, recorded_at FROM sync_gaps ORDER BY from_block"
    )
    .all() as SyncGap[];
}

// analytics queries

/**
 * Count all indexed bids (all-time, no dedup beyond the fact table's own UNIQUE constraint).
 *
 * @returns Total row count in the bids table.
 */
export function getBidCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM bids").get() as { cnt: number };
  return row.cnt;
}

/**
 * Count all indexed evictions.
 *
 * @returns Total row count in the evictions table.
 */
export function getEvictionCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM evictions").get() as { cnt: number };
  return row.cnt;
}

/**
 * Count distinct programs ever observed in a bid.
 *
 * @returns Total row count in the programs dim table.
 */
export function getUniqueProgramCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM programs").get() as { cnt: number };
  return row.cnt;
}

// a codehash is currently cached if its latest bid is not yet followed by an eviction
// at a later (block, log_index). Returns the set plus sizes for reconciliation.
/** A codehash currently believed to be resident in the cache, with its size in bytes. */
export interface CachedEntry {
  codehash: `0x${string}`;
  size: number;
}

/**
 * Compute the set of codehashes currently cached, derived purely from indexed history:
 * a codehash is "cached" if its most recent bid (by block_number, log_index) has no
 * later eviction. Used to reconcile local state against the live on-chain cache.
 *
 * @returns Currently-cached codehashes with their sizes.
 */
export function getCurrentlyCached(): CachedEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
      WITH latest_bid AS (
        SELECT codehash_id, size, block_number, log_index
        FROM (
          SELECT codehash_id, size, block_number, log_index,
                 ROW_NUMBER() OVER (
                   PARTITION BY codehash_id
                   ORDER BY block_number DESC, log_index DESC
                 ) AS rn
          FROM bids
        )
        WHERE rn = 1
      ),
      latest_evict AS (
        SELECT codehash_id, block_number, log_index
        FROM (
          SELECT codehash_id, block_number, log_index,
                 ROW_NUMBER() OVER (
                   PARTITION BY codehash_id
                   ORDER BY block_number DESC, log_index DESC
                 ) AS rn
          FROM evictions
        )
        WHERE rn = 1
      )
      SELECT c.codehash AS codehash, lb.size AS size
      FROM latest_bid lb
      JOIN codehashes c ON c.id = lb.codehash_id
      LEFT JOIN latest_evict le ON le.codehash_id = lb.codehash_id
      WHERE le.codehash_id IS NULL
         OR le.block_number <  lb.block_number
         OR (le.block_number = lb.block_number AND le.log_index < lb.log_index)
      `
    )
    .all() as { codehash: Buffer; size: number }[];

  return rows.map((r) => ({ codehash: bufToHex(r.codehash), size: r.size }));
}

// Resolve the most recently seen codehash for a program address from the
// indexed bid history. Returns null if we've never observed a bid for it.
/**
 * Resolve the most recently seen codehash for a program address from indexed history.
 *
 * @param program - Program (contract) address to look up.
 * @returns The latest known codehash for this program, or null if never observed.
 */
export function getCodehashForProgram(
  program: `0x${string}`
): `0x${string}` | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT c.codehash AS codehash
         FROM codehashes c
         JOIN programs p ON p.id = c.program_id
        WHERE p.address = ?
        ORDER BY c.first_seen_block DESC
        LIMIT 1`
    )
    .get(hexToBuf(program)) as { codehash: Buffer } | undefined;
  return row ? bufToHex(row.codehash) : null;
}

// Resolve the program address last associated with a codehash, if known.
/**
 * Resolve the program address last associated with a codehash, if known.
 *
 * @param codehash - Codehash to look up.
 * @returns The associated program address, or null if the codehash has no linked program.
 */
export function getProgramForCodehash(
  codehash: `0x${string}`
): `0x${string}` | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT p.address AS address
         FROM codehashes c
         JOIN programs p ON p.id = c.program_id
        WHERE c.codehash = ?
        LIMIT 1`
    )
    .get(hexToBuf(codehash)) as { address: Buffer } | undefined;
  return row ? bufToHex(row.address) : null;
}

// bid_actions — audit trail of sentinel bid decisions (M4)

/** Lifecycle status of a sentinel bid decision, from initial evaluation through on-chain confirmation. */
export type BidActionStatus =
  | "dry-run"
  | "blocked"
  | "submitted"
  | "confirmed"
  | "failed";

/** Fields required to record a new bid_actions row. */
export interface BidActionInput {
  codehash: `0x${string}`;
  program: `0x${string}` | null;
  bidWei: string;
  status: BidActionStatus;
  txHash: `0x${string}` | null;
  reason: string;
}

/**
 * Insert a new bid_actions audit row recording a sentinel bid decision.
 *
 * @param action - Decision details to record.
 * @returns The new row's id (for later updateBidAction calls as the tx progresses).
 */
export function recordBidAction(action: BidActionInput): number {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO bid_actions
         (codehash, program, bid_wei, status, tx_hash, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      hexToBuf(action.codehash),
      action.program ? hexToBuf(action.program) : null,
      action.bidWei,
      action.status,
      action.txHash ? hexToBuf(action.txHash) : null,
      action.reason,
      Math.floor(Date.now() / 1000)
    );
  return Number(info.lastInsertRowid);
}

/**
 * Patch an existing bid_actions row in place (e.g. status: submitted -> confirmed,
 * attaching txHash/confirmedAt once known). Only the fields present in `patch` are
 * updated; omitted fields are left untouched. No-op if `patch` is empty.
 *
 * @param id - Row id returned by recordBidAction.
 * @param patch - Partial fields to update.
 */
export function updateBidAction(
  id: number,
  patch: { status?: BidActionStatus; txHash?: `0x${string}` | null; confirmedAt?: number }
): void {
  const db = getDb();
  const sets: string[] = [];
  const params: (string | number | Buffer | null)[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.txHash !== undefined) {
    sets.push("tx_hash = ?");
    params.push(patch.txHash ? hexToBuf(patch.txHash) : null);
  }
  if (patch.confirmedAt !== undefined) {
    sets.push("confirmed_at = ?");
    params.push(patch.confirmedAt);
  }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE bid_actions SET ${sets.join(", ")} WHERE id = ?`).run(
    ...params
  );
}

// Sum of wei committed since a unix timestamp. Used by the per-window spend
// cap. Counts submitted/confirmed bids; pass includeDryRun to also count
// dry-run rows, so a dry-run loop can preview whether live mode would hit the
// cap. Summed in BigInt to avoid float loss.
/**
 * Sum bid_wei across bid_actions created at or after `sinceUnix`, for enforcing the
 * per-window spend cap.
 *
 * @param sinceUnix - Unix timestamp (seconds); rows created at or after this are included.
 * @param opts.includeDryRun - When true, also counts `dry-run` rows (in addition to
 *   `submitted`/`confirmed`), letting a dry-run loop preview whether live mode would
 *   breach the cap. Defaults to counting only `submitted`/`confirmed`.
 * @returns Total wei spent in the window, summed as BigInt to avoid float precision loss.
 */
export function getSpendWeiSince(
  sinceUnix: number,
  opts: { includeDryRun?: boolean } = {}
): bigint {
  const db = getDb();
  const statuses = opts.includeDryRun
    ? "('submitted','confirmed','dry-run')"
    : "('submitted','confirmed')";
  const rows = db
    .prepare(
      `SELECT bid_wei FROM bid_actions
        WHERE created_at >= ? AND status IN ${statuses}`
    )
    .all(sinceUnix) as { bid_wei: string }[];
  return rows.reduce((acc, r) => acc + BigInt(r.bid_wei), 0n);
}

/**
 * When the sentinel last recorded any action for a codehash, in unix milliseconds.
 *
 * Backs the per-target cooldown. Reading it from the audit trail rather than from
 * process memory is what lets the cooldown survive a restart — including the
 * watchdog-initiated restarts that are a designed part of the run loop. Counts
 * every status, matching the loop's rule that acting on a target at all starts
 * its cooldown.
 *
 * Note the second-level resolution: `created_at` is stored in seconds, so the
 * returned value is rounded down to the second. Cooldowns are minutes long, so
 * this is immaterial.
 *
 * @param codehash - the target's codehash
 * @returns unix milliseconds of the most recent action, or null if there has never been one
 */
export function getLastBidActionAtMs(codehash: `0x${string}`): number | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT created_at FROM bid_actions
        WHERE codehash = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`
    )
    .get(hexToBuf(codehash)) as { created_at: number } | undefined;
  return row ? row.created_at * 1000 : null;
}

/** A bid_actions row as read back from the DB, with hex-decoded BLOB fields. */
export interface BidActionRow {
  id: number;
  codehash: `0x${string}`;
  program: `0x${string}` | null;
  bid_wei: string;
  status: BidActionStatus;
  tx_hash: `0x${string}` | null;
  reason: string | null;
  created_at: number;
  confirmed_at: number | null;
}

/**
 * List the most recent bid_actions rows, newest first.
 *
 * @param limit - Max rows to return. Defaults to 20.
 * @returns Recent bid action rows ordered by created_at, id descending.
 */
export function listRecentBidActions(limit = 20): BidActionRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, codehash, program, bid_wei, status, tx_hash, reason, created_at, confirmed_at
         FROM bid_actions ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(limit) as {
    id: number;
    codehash: Buffer;
    program: Buffer | null;
    bid_wei: string;
    status: BidActionStatus;
    tx_hash: Buffer | null;
    reason: string | null;
    created_at: number;
    confirmed_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    codehash: bufToHex(r.codehash),
    program: r.program ? bufToHex(r.program) : null,
    bid_wei: r.bid_wei,
    status: r.status,
    tx_hash: r.tx_hash ? bufToHex(r.tx_hash) : null,
    reason: r.reason,
    created_at: r.created_at,
    confirmed_at: r.confirmed_at,
  }));
}

/** Most recently indexed CacheManager config values, each independently latest by its own event type. */
export interface LatestConfigEvents {
  cacheSize: string | null;
  decay: string | null;
  paused: boolean | null;
}

/**
 * Derive the latest known CacheManager config state purely from indexed config_events
 * (cache size, decay rate, pause/unpause), each resolved independently as the most
 * recent event of its type. Distinct from readCacheState (types.ts / indexer/state.ts),
 * which reads live on-chain state instead of the local DB.
 *
 * @returns Latest cache size, decay rate, and pause state, each null if never observed.
 */
export function getLatestConfigState(): LatestConfigEvents {
  const db = getDb();
  const latest = (type: string): string | null => {
    const row = db
      .prepare(
        `SELECT value FROM config_events WHERE event_type = ?
         ORDER BY block_number DESC, log_index DESC LIMIT 1`
      )
      .get(type) as { value: string | null } | undefined;
    return row?.value ?? null;
  };

  const pauseRow = db
    .prepare(
      `SELECT event_type FROM config_events
        WHERE event_type IN ('Pause','Unpause')
        ORDER BY block_number DESC, log_index DESC LIMIT 1`
    )
    .get() as { event_type: string } | undefined;

  return {
    cacheSize: latest("SetCacheSize"),
    decay: latest("SetDecayRate"),
    paused: pauseRow ? pauseRow.event_type === "Pause" : null,
  };
}
