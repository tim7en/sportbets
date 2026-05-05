require("dotenv").config();

const path = require("path");
const { createDatabase } = require("./db");
const { fetchTodayGamesAndOdds } = require("./oddsFetcher");
const { populateOddsSnapshot } = require("./populateOdds");

function readConfigFromEnv() {
  return {
    apiKey: (process.env.ODDS_API || "").replace(/^"|"$/g, "").trim(),
    baseUrl: (process.env.ODDS_API_BASE_URL || "https://api.the-odds-api.com/v4").trim(),
    maxCalls: Number(process.env.ODDS_API_MAX_CALLS || 5),
    regions: process.env.ODDS_API_REGIONS || "us",
    markets: process.env.ODDS_API_MARKETS || "h2h",
    oddsFormat: process.env.ODDS_API_ODDS_FORMAT || "decimal",
    dateFormat: process.env.ODDS_API_DATE_FORMAT || "iso",
    sports: process.env.ODDS_API_SPORTS || "",
    dbPath: process.env.DB_PATH || path.join(process.cwd(), "data", "sportbets.db"),
  };
}

async function main() {
  const config = readConfigFromEnv();

  const db = createDatabase(config.dbPath);
  try {
    const { games, usage } = await fetchTodayGamesAndOdds(config);
    const { gamesUpserted } = populateOddsSnapshot(db, games);

    console.log(JSON.stringify({
      status: "ok",
      gamesFetched: games.length,
      gamesUpserted,
      apiCallsUsed: usage.callsUsed,
      apiCallsLimit: usage.maxCalls,
      dbPath: config.dbPath,
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("Failed to fetch/populate odds:", err.message);
  process.exitCode = 1;
});
