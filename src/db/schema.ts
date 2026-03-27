import Database from "better-sqlite3";

// init tables
export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bids (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      codehash      TEXT    NOT NULL,
      program       TEXT    NOT NULL,
      bid           TEXT    NOT NULL,
      size          INTEGER NOT NULL,
      block_number  INTEGER NOT NULL,
      tx_hash       TEXT    NOT NULL,
      log_index     INTEGER NOT NULL,
      timestamp     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bids_codehash ON bids(codehash);
    CREATE INDEX IF NOT EXISTS idx_bids_program  ON bids(program);
    CREATE INDEX IF NOT EXISTS idx_bids_block    ON bids(block_number);

    CREATE TABLE IF NOT EXISTS evictions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      codehash      TEXT    NOT NULL,
      bid           TEXT    NOT NULL,
      size          INTEGER NOT NULL,
      block_number  INTEGER NOT NULL,
      tx_hash       TEXT    NOT NULL,
      log_index     INTEGER NOT NULL,
      timestamp     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_evictions_codehash ON evictions(codehash);
    CREATE INDEX IF NOT EXISTS idx_evictions_block    ON evictions(block_number);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
