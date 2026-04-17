import Database from "better-sqlite3";
import { config } from "../config";
import { initSchema } from "./schema";

let _db: Database.Database | null = null;

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

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function hexToBuf(hex: string): Buffer {
  return Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
}

export function bufToHex(buf: Buffer | Uint8Array): `0x${string}` {
  return ("0x" + Buffer.from(buf).toString("hex")) as `0x${string}`;
}

// sync_meta

export function getLastSyncedBlock(): number | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM sync_meta WHERE key = ?")
    .get("last_block") as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : null;
}

export function setLastSyncedBlock(block: number): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run("last_block", block.toString());
}

export function setSyncMeta(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getSyncMeta(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM sync_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

// parsed row shapes — produced by format.ts, consumed here

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

export interface ParsedEviction {
  codehash: `0x${string}`;
  bidWei: string;
  size: number;
  blockNumber: number;
  txHash: `0x${string}`;
  logIndex: number;
  timestamp: number;
}

export interface ParsedConfigEvent {
  eventType: "SetCacheSize" | "SetDecayRate" | "Pause" | "Unpause";
  value: string | null;
  blockNumber: number;
  txHash: `0x${string}`;
  logIndex: number;
  timestamp: number;
}

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

export interface SyncGap {
  from_block: number;
  to_block: number;
  reason: string | null;
  recorded_at: number;
}

export function listSyncGaps(): SyncGap[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT from_block, to_block, reason, recorded_at FROM sync_gaps ORDER BY from_block"
    )
    .all() as SyncGap[];
}

// analytics queries

export function getBidCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM bids").get() as { cnt: number };
  return row.cnt;
}

export function getEvictionCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM evictions").get() as { cnt: number };
  return row.cnt;
}

export function getUniqueProgramCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM programs").get() as { cnt: number };
  return row.cnt;
}

// a codehash is currently cached if its latest bid is not yet followed by an eviction
// at a later (block, log_index). Returns the set plus sizes for reconciliation.
export interface CachedEntry {
  codehash: `0x${string}`;
  size: number;
}

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

export interface LatestConfigEvents {
  cacheSize: string | null;
  decay: string | null;
  paused: boolean | null;
}

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
