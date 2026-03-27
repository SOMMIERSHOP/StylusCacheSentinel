import Database from "better-sqlite3";
import { config } from "../config";
import { initSchema } from "./schema";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
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

// sync meta

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

// bids

export interface BidRow {
  codehash: string;
  program: string;
  bid: string;
  size: number;
  block_number: number;
  tx_hash: string;
  log_index: number;
  timestamp: number;
}

export function insertBids(rows: BidRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO bids (codehash, program, bid, size, block_number, tx_hash, log_index, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((items: BidRow[]) => {
    for (const r of items) {
      stmt.run(r.codehash, r.program, r.bid, r.size, r.block_number, r.tx_hash, r.log_index, r.timestamp);
    }
  });
  tx(rows);
}

// evictions

export interface EvictionRow {
  codehash: string;
  bid: string;
  size: number;
  block_number: number;
  tx_hash: string;
  log_index: number;
  timestamp: number;
}

export function insertEvictions(rows: EvictionRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO evictions (codehash, bid, size, block_number, tx_hash, log_index, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((items: EvictionRow[]) => {
    for (const r of items) {
      stmt.run(r.codehash, r.bid, r.size, r.block_number, r.tx_hash, r.log_index, r.timestamp);
    }
  });
  tx(rows);
}

// queries

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
  const row = db
    .prepare("SELECT COUNT(DISTINCT program) as cnt FROM bids")
    .get() as { cnt: number };
  return row.cnt;
}
