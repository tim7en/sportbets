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
  `);

  return db;
}

module.exports = {
  createDatabase,
};
