const Database = require("better-sqlite3");

function toDecimalOdds(rawPrice) {
  const price = Number(rawPrice);
  if (!Number.isFinite(price)) {
    return null;
  }

  if (price > 1 && price < 100) {
    return price;
  }

  if (price >= 100) {
    return 1 + price / 100;
  }

  if (price <= -100) {
    return 1 + 100 / Math.abs(price);
  }

  return null;
}

function buildUpcomingRatioTable(dbPath = "data/sportbets.db") {
  const db = new Database(dbPath);

  try {
    const now = new Date().toISOString();
    const sql = `
      SELECT
        g.game_id,
        g.sport_title,
        g.commence_time,
        g.home_team,
        g.away_team,
        o.outcome_name,
        o.price
      FROM games g
      JOIN odds o ON o.game_id = g.game_id AND o.market_key = 'h2h'
      WHERE g.commence_time >= ?
      ORDER BY g.commence_time ASC
    `;

    const rows = db.prepare(sql).all(now);
    const byGame = new Map();

    for (const row of rows) {
      if (!byGame.has(row.game_id)) {
        byGame.set(row.game_id, {
          sport: row.sport_title,
          time: row.commence_time,
          home: row.home_team,
          away: row.away_team,
          homeBest: null,
          awayBest: null,
        });
      }

      const game = byGame.get(row.game_id);
      const decimal = toDecimalOdds(row.price);
      if (!decimal) {
        continue;
      }

      const outcomeName = String(row.outcome_name || "").trim().toLowerCase();
      const homeName = String(game.home || "").trim().toLowerCase();
      const awayName = String(game.away || "").trim().toLowerCase();

      if (outcomeName === homeName) {
        game.homeBest = game.homeBest === null ? decimal : Math.max(game.homeBest, decimal);
      } else if (outcomeName === awayName) {
        game.awayBest = game.awayBest === null ? decimal : Math.max(game.awayBest, decimal);
      }
    }

    const tableRows = [];
    for (const game of byGame.values()) {
      if (!game.homeBest || !game.awayBest) {
        continue;
      }

      const homeProb = 1 / game.homeBest;
      const awayProb = 1 / game.awayBest;

      tableRows.push({
        sport: game.sport,
        startUtc: game.time,
        game: `${game.away} @ ${game.home}`,
        homeOdds: Number(game.homeBest.toFixed(3)),
        awayOdds: Number(game.awayBest.toFixed(3)),
        homeProbPct: Number((homeProb * 100).toFixed(2)),
        awayProbPct: Number((awayProb * 100).toFixed(2)),
        ratio: Number((homeProb / awayProb).toFixed(3)),
      });
    }

    tableRows.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
    return tableRows;
  } finally {
    db.close();
  }
}

function printMarkdownTable(rows) {
  if (!rows.length) {
    console.log("No upcoming games found.");
    return;
  }

  console.log("| Sport | Start (UTC) | Game | Home % | Away % | Win/Loss Ratio |");
  console.log("|---|---|---|---:|---:|---:|");

  for (const row of rows) {
    console.log(
      `| ${row.sport} | ${row.startUtc} | ${row.game} | ${row.homeProbPct} | ${row.awayProbPct} | ${row.ratio} |`
    );
  }
}

const rows = buildUpcomingRatioTable();
printMarkdownTable(rows);
