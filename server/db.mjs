// SQLite schema + helpers. Node 24 ships node:sqlite, so no native build step.
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const DB_PATH = fileURLToPath(new URL('./data/catalog.db', import.meta.url))

export function openDB(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS shows (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      year        INTEGER,
      category    TEXT NOT NULL,
      genres      TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      poster      TEXT NOT NULL DEFAULT '',
      downloads   INTEGER NOT NULL DEFAULT 0,
      runtime     REAL,
      license     TEXT,
      collection  TEXT,
      added       TEXT
    );
    CREATE TABLE IF NOT EXISTS episodes (
      show_id TEXT NOT NULL,
      idx     INTEGER NOT NULL,
      label   TEXT NOT NULL,
      stream  TEXT NOT NULL,
      length  REAL,
      quality TEXT,
      PRIMARY KEY (show_id, idx),
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS progress (
      show_id  TEXT NOT NULL,
      idx      INTEGER NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      duration REAL,
      updated  TEXT NOT NULL,
      PRIMARY KEY (show_id, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_shows_cat ON shows(category);
    CREATE INDEX IF NOT EXISTS idx_shows_dl  ON shows(downloads DESC);
  `)
  return db
}
