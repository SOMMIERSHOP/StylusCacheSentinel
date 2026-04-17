import Database from "better-sqlite3";

export const SCHEMA_VERSION = "2";

// v1 had TEXT-hex codehash/program/tx_hash and no UNIQUE(tx_hash, log_index).
// v2 normalizes programs+codehashes into dim tables, stores hashes as BLOB,
// and dedupes facts via UNIQUE(tx_hash, log_index). Storage drops ~50%+ and
// re-running backfill becomes idempotent.
export function initSchema(db: Database.Database): void {
  const currentVersion = readSchemaVersion(db);

  if (currentVersion !== null && currentVersion !== SCHEMA_VERSION) {
    dropAllTables(db);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS programs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      address           BLOB    NOT NULL UNIQUE,
      first_seen_block  INTEGER NOT NULL,
      first_seen_ts     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codehashes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      codehash          BLOB    NOT NULL UNIQUE,
      program_id        INTEGER,
      size              INTEGER,
      first_seen_block  INTEGER NOT NULL,
      first_seen_ts     INTEGER NOT NULL,
      FOREIGN KEY (program_id) REFERENCES programs(id)
    );

    CREATE TABLE IF NOT EXISTS bids (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      codehash_id  INTEGER NOT NULL,
      program_id   INTEGER NOT NULL,
      bid_wei      TEXT    NOT NULL,
      size         INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      tx_hash      BLOB    NOT NULL,
      log_index    INTEGER NOT NULL,
      timestamp    INTEGER NOT NULL,
      UNIQUE (tx_hash, log_index),
      FOREIGN KEY (codehash_id) REFERENCES codehashes(id),
      FOREIGN KEY (program_id)  REFERENCES programs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_bids_codehash_id ON bids(codehash_id);
    CREATE INDEX IF NOT EXISTS idx_bids_program_id  ON bids(program_id);
    CREATE INDEX IF NOT EXISTS idx_bids_block       ON bids(block_number);

    CREATE TABLE IF NOT EXISTS evictions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      codehash_id  INTEGER NOT NULL,
      bid_wei      TEXT    NOT NULL,
      size         INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      tx_hash      BLOB    NOT NULL,
      log_index    INTEGER NOT NULL,
      timestamp    INTEGER NOT NULL,
      UNIQUE (tx_hash, log_index),
      FOREIGN KEY (codehash_id) REFERENCES codehashes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_evictions_codehash_id ON evictions(codehash_id);
    CREATE INDEX IF NOT EXISTS idx_evictions_block       ON evictions(block_number);

    CREATE TABLE IF NOT EXISTS config_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type   TEXT    NOT NULL,
      value        TEXT,
      block_number INTEGER NOT NULL,
      tx_hash      BLOB    NOT NULL,
      log_index    INTEGER NOT NULL,
      timestamp    INTEGER NOT NULL,
      UNIQUE (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_config_events_block ON config_events(block_number);
    CREATE INDEX IF NOT EXISTS idx_config_events_type  ON config_events(event_type);

    CREATE TABLE IF NOT EXISTS sync_gaps (
      from_block  INTEGER NOT NULL,
      to_block    INTEGER NOT NULL,
      reason      TEXT,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (from_block, to_block)
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run("schema_version", SCHEMA_VERSION);
}

function readSchemaVersion(db: Database.Database): string | null {
  const metaExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_meta'")
    .get();
  if (!metaExists) {
    const anyLegacy = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bids','evictions')"
      )
      .get();
    return anyLegacy ? "1" : null;
  }
  const row = db
    .prepare("SELECT value FROM sync_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row?.value ?? "1";
}

function dropAllTables(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS bids;
    DROP TABLE IF EXISTS evictions;
    DROP TABLE IF EXISTS codehashes;
    DROP TABLE IF EXISTS programs;
    DROP TABLE IF EXISTS config_events;
    DROP TABLE IF EXISTS sync_gaps;
    DROP TABLE IF EXISTS sync_meta;
  `);
}
