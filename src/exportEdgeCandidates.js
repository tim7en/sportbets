require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createDatabase } = require("./db");

function toDecimalOdds(rawPrice) {
  if (rawPrice === null || rawPrice === undefined) {
    return null;
  }

  const price = Number(rawPrice);
  if (!Number.isFinite(price)) {
    return null;
  }

  // If configured as decimal odds, values are typically >= 1.01.
  if (price > 1 && price < 100) {
    return price;
  }

  // Convert american odds when present.
  if (price >= 100) {
    return 1 + price / 100;
  }

  if (price <= -100) {
    return 1 + 100 / Math.abs(price);
  }

  return null;
}

function normalizeOutcomeName(game, outcomeName) {
  if (!outcomeName) {
    return "unknown";
  }

  const lower = String(outcomeName).trim().toLowerCase();
  if (lower === "draw" || lower === "tie") {
    return "draw";
  }

  if (game.home_team && lower === String(game.home_team).trim().toLowerCase()) {
    return "home";
  }

  if (game.away_team && lower === String(game.away_team).trim().toLowerCase()) {
    return "away";
  }

  return lower;
}

function buildEdgeCandidates(db) {
  const rows = db.prepare(`
    SELECT
      g.game_id,
      g.sport_key,
      g.sport_title,
      g.commence_time,
      g.home_team,
      g.away_team,
      b.bookmaker_key,
      b.bookmaker_title,
      o.market_key,
      o.outcome_name,
      o.price,
      o.point
    FROM odds o
    JOIN games g ON g.game_id = o.game_id
    JOIN bookmakers b
      ON b.game_id = o.game_id
     AND b.bookmaker_key = o.bookmaker_key
    WHERE o.market_key = 'h2h'
    ORDER BY g.commence_time ASC
  `).all();

  const byOutcome = new Map();
  const overroundByBookmaker = new Map();

  for (const row of rows) {
    const decimalPrice = toDecimalOdds(row.price);
    if (!decimalPrice || decimalPrice <= 1) {
      continue;
    }

    const impliedProbability = 1 / decimalPrice;
    const normalizedOutcome = normalizeOutcomeName(row, row.outcome_name);

    const outcomeKey = [
      row.game_id,
      row.market_key,
      normalizedOutcome,
      row.point ?? "",
    ].join("::");

    const prev = byOutcome.get(outcomeKey);
    if (!prev || decimalPrice > prev.best_decimal_price) {
      byOutcome.set(outcomeKey, {
        game_id: row.game_id,
        sport_key: row.sport_key,
        sport_title: row.sport_title,
        commence_time: row.commence_time,
        home_team: row.home_team,
        away_team: row.away_team,
        market_key: row.market_key,
        outcome_name: row.outcome_name,
        normalized_outcome: normalizedOutcome,
        point: row.point,
        best_decimal_price: Number(decimalPrice.toFixed(6)),
        implied_probability: Number(impliedProbability.toFixed(6)),
        best_bookmaker_key: row.bookmaker_key,
        best_bookmaker_title: row.bookmaker_title,
      });
    }

    const overroundKey = [row.game_id, row.bookmaker_key, row.market_key].join("::");
    const existingOverround = overroundByBookmaker.get(overroundKey) || {
      game_id: row.game_id,
      sport_title: row.sport_title,
      home_team: row.home_team,
      away_team: row.away_team,
      commence_time: row.commence_time,
      bookmaker_key: row.bookmaker_key,
      bookmaker_title: row.bookmaker_title,
      market_key: row.market_key,
      implied_sum: 0,
      outcomes: 0,
    };

    existingOverround.implied_sum += impliedProbability;
    existingOverround.outcomes += 1;
    overroundByBookmaker.set(overroundKey, existingOverround);
  }

  const candidates = Array.from(byOutcome.values());
  const overround = Array.from(overroundByBookmaker.values()).map((x) => ({
    ...x,
    implied_sum: Number(x.implied_sum.toFixed(6)),
    hold_pct: Number(((x.implied_sum - 1) * 100).toFixed(4)),
  }));

  return { candidates, overround };
}

function writeJsonl(filePath, rows) {
  const content = rows.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(filePath, content);
}

function main() {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "sportbets.db");
  const db = createDatabase(dbPath);

  try {
    const { candidates, overround } = buildEdgeCandidates(db);

    const outDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const candidatesFile = path.join(outDir, "edge_candidates.jsonl");
    const overroundFile = path.join(outDir, "bookmaker_overround_h2h.jsonl");
    writeJsonl(candidatesFile, candidates);
    writeJsonl(overroundFile, overround);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          candidates: candidates.length,
          bookmakerOverroundRows: overround.length,
          candidatesFile,
          overroundFile,
        },
        null,
        2
      )
    );
  } finally {
    db.close();
  }
}

main();
