const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function createDatabase(dbPath = path.join(process.cwd(), "data", "sportbets.db")) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      game_id TEXT PRIMARY KEY,
      sport_key TEXT NOT NULL,
      sport_title TEXT NOT NULL,
      commence_time TEXT NOT NULL,
      home_team TEXT,
      away_team TEXT,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmakers (
      game_id TEXT NOT NULL,
      bookmaker_key TEXT NOT NULL,
      bookmaker_title TEXT NOT NULL,
      last_update TEXT,
      PRIMARY KEY (game_id, bookmaker_key),
      FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS odds (
      game_id TEXT NOT NULL,
      bookmaker_key TEXT NOT NULL,
      market_key TEXT NOT NULL,
      outcome_name TEXT NOT NULL,
      price REAL,
      point REAL,
      PRIMARY KEY (game_id, bookmaker_key, market_key, outcome_name),
      FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_games_commence_time ON games(commence_time);
    CREATE INDEX IF NOT EXISTS idx_games_sport_key ON games(sport_key);

    CREATE TABLE IF NOT EXISTS team_entities (
      team_entity_id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_aliases (
      team_alias_id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_entity_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      alias_name TEXT NOT NULL,
      alias_normalized TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source, alias_normalized),
      FOREIGN KEY (team_entity_id) REFERENCES team_entities(team_entity_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS polymarket_events (
      polymarket_event_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT,
      sport_hint TEXT,
      start_time TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_mappings (
      polymarket_event_id TEXT PRIMARY KEY,
      game_id TEXT,
      confidence_score REAL NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (polymarket_event_id) REFERENCES polymarket_events(polymarket_event_id) ON DELETE CASCADE,
      FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS mapping_overrides (
      polymarket_event_id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (polymarket_event_id) REFERENCES polymarket_events(polymarket_event_id) ON DELETE CASCADE,
      FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_team_aliases_normalized ON team_aliases(alias_normalized);
    CREATE INDEX IF NOT EXISTS idx_polymarket_events_start_time ON polymarket_events(start_time);
    CREATE INDEX IF NOT EXISTS idx_event_mappings_status ON event_mappings(status);
    CREATE INDEX IF NOT EXISTS idx_mapping_overrides_game_id ON mapping_overrides(game_id);
  `);

  return db;
}

module.exports = {
  createDatabase,
};
