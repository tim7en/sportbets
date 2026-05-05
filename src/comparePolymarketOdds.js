require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { parseMatchTeams, teamSimilarity } = require("./nameMatch");
const { classifyQuestion } = require("./polymarketMarketTypes");

const FORBIDDEN_EVENT_TITLE_PATTERNS = [
  /more markets/i,
  /top goalscorer/i,
  /top\s+4/i,
  /winner/i,
  /champion/i,
  /qualif(y|ier|ication)/i,
  /playoff/i,
  /series/i,
  /tournament/i,
  /\bbo[1-9]\b/i,
  /group stage/i,
  /round\s+\d+/i,
  /to advance/i,
  /to lift/i,
];

function isForbiddenByPatterns(value, patterns) {
  const text = String(value || "");
  return patterns.some((pattern) => pattern.test(text));
}

function cleanMatchParticipant(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.includes(":")) {
    text = text.split(":").pop().trim();
  }

  return text
    .replace(/\s+-\s+[^-]+$/g, "")
    .replace(/\s+\([^)]*\)\s*$/g, "")
    .trim();
}

function parseComparableTeams(title) {
  const parsed = parseMatchTeams(title);
  if (!parsed) {
    return false;
  }

  return {
    left: cleanMatchParticipant(parsed.left),
    right: cleanMatchParticipant(parsed.right),
  };
}

function isComparableEventTitle(title) {
  const filterMode = String(process.env.COMPARE_FILTER_MODE || "strict")
    .trim()
    .toLowerCase();

  if (
    filterMode === "strict" &&
    isForbiddenByPatterns(title, FORBIDDEN_EVENT_TITLE_PATTERNS)
  ) {
    return false;
  }

  const parsed = parseComparableTeams(title);
  if (!parsed) {
    return false;
  }

  const left = String(parsed.left || "").trim();
  const right = String(parsed.right || "").trim();
  if (!left || !right) {
    return false;
  }

  if (
    filterMode === "strict" &&
    isForbiddenByPatterns(left, FORBIDDEN_EVENT_TITLE_PATTERNS)
  ) {
    return false;
  }
  if (
    filterMode === "strict" &&
    isForbiddenByPatterns(right, FORBIDDEN_EVENT_TITLE_PATTERNS)
  ) {
    return false;
  }

  return true;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseCsvEnv(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function resolveConfigPath(filePath) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.join(process.cwd(), filePath);
}

function loadCompareMarketCrosswalk() {
  const configuredPath = String(
    process.env.COMPARE_MARKET_CROSSWALK_FILE ||
      path.join("config", "polymarketMarketCrosswalk.js")
  ).trim();
  const resolvedPath = resolveConfigPath(configuredPath);
  const loaded = require(resolvedPath);
  const comparableMarkets = Array.isArray(loaded.comparableMarkets)
    ? loaded.comparableMarkets
        .filter((rule) => rule && rule.enabled !== false)
        .filter((rule) => String(rule.bookmakerMarketKey || "h2h") === "h2h")
    : [];

  return {
    filePath: resolvedPath,
    comparableMarkets,
    rulesByType: new Map(
      comparableMarkets.map((rule) => [String(rule.type || "").trim(), rule])
    ),
  };
}

function isAllowedCompareMarketType(type, compareConfig) {
  return compareConfig.rulesByType.has(String(type || "").trim());
}

function getCompareMarketRule(type, compareConfig) {
  return compareConfig.rulesByType.get(String(type || "").trim()) || null;
}

function getDbGames(db, options = {}) {
  const sportKeys = parseCsvEnv(options.sportKeys);
  const params = [];

  let sql = `
    SELECT game_id, sport_key, sport_title, commence_time, home_team, away_team
    FROM games
    WHERE commence_time >= datetime('now', '-1 day')
  `;

  if (sportKeys.length > 0) {
    sql += ` AND sport_key IN (${sportKeys.map(() => "?").join(",")})`;
    params.push(...sportKeys);
  }

  return db.prepare(sql).all(...params);
}

function getBestOdds(db, gameId) {
  const row = db
    .prepare(
      `
      SELECT
        g.game_id,
        g.home_team,
        g.away_team,
        MAX(CASE WHEN lower(o.outcome_name)=lower(g.home_team) THEN o.price END) AS home_best,
        MAX(CASE WHEN lower(o.outcome_name)=lower(g.away_team) THEN o.price END) AS away_best
      FROM games g
      JOIN odds o ON o.game_id = g.game_id AND o.market_key = 'h2h'
      WHERE g.game_id = ?
      GROUP BY g.game_id, g.home_team, g.away_team
    `
    )
    .get(gameId);

  if (!row || !row.home_best || !row.away_best) {
    return null;
  }

  return row;
}

function impliedProbFromDecimal(odds) {
  const x = Number(odds);
  if (!Number.isFinite(x) || x <= 1) {
    return null;
  }
  return 1 / x;
}

function findBestGameMatch(event, games) {
  if (!isComparableEventTitle(event.title)) {
    return null;
  }

  const parsed = parseComparableTeams(event.title);
  if (!parsed) {
    return null;
  }

  const eventTime = new Date(event.end_time || event.start_time || 0).getTime();
  const minNameScore = Number(process.env.COMPARE_MIN_NAME_SCORE || 0.55);
  const minTotalScore = Number(process.env.COMPARE_MIN_TOTAL_SCORE || 0.62);
  const timeWindowHours = Number(process.env.COMPARE_TIME_WINDOW_HOURS || 72);
  let best = null;

  for (const game of games) {
    const direct =
      (teamSimilarity(parsed.left, game.home_team) +
        teamSimilarity(parsed.right, game.away_team)) /
      2;
    const swapped =
      (teamSimilarity(parsed.left, game.away_team) +
        teamSimilarity(parsed.right, game.home_team)) /
      2;
    const nameScore = Math.max(direct, swapped);

    if (nameScore < minNameScore) {
      continue;
    }

    let timeScore = 0.5;
    const gameTime = new Date(game.commence_time).getTime();
    if (Number.isFinite(eventTime) && Number.isFinite(gameTime)) {
      const diffHours = Math.abs(eventTime - gameTime) / (1000 * 60 * 60);
      timeScore = Math.max(0, 1 - diffHours / timeWindowHours);
    }

    const score = 0.8 * nameScore + 0.2 * timeScore;
    if (!best || score > best.score) {
      best = { game, score };
    }
  }

  return best && best.score >= minTotalScore ? best : null;
}

function pickPolymarketSideProbability(outcomes, teamName) {
  let best = null;
  for (const o of outcomes) {
    const s = teamSimilarity(o.name, teamName);
    if (!best || s > best.similarity) {
      best = { probability: Number(o.probability), similarity: s };
    }
  }

  if (!best || best.similarity < 0.7 || !Number.isFinite(best.probability)) {
    return null;
  }
  return best.probability;
}

function pickBestMarketForTeams(event, homeTeam, awayTeam, allowedMarketTypes) {
  const markets = Array.isArray(event.markets) ? event.markets : [];
  let best = null;

  for (const market of markets) {
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    const marketType = classifyQuestion(event.title, market.question, outcomes);
    if (
      marketType !== "match_winner" ||
      !isAllowedCompareMarketType(marketType, allowedMarketTypes)
    ) {
      continue;
    }

    if (!outcomes.length) {
      continue;
    }

    const home = pickPolymarketSideProbability(outcomes, homeTeam);
    const away = pickPolymarketSideProbability(outcomes, awayTeam);
    if (home === null || away === null) {
      continue;
    }

    const homeSim = Math.max(
      ...outcomes.map((o) => teamSimilarity(o.name, homeTeam)),
      0
    );
    const awaySim = Math.max(
      ...outcomes.map((o) => teamSimilarity(o.name, awayTeam)),
      0
    );
    const score = (homeSim + awaySim) / 2;

    if (!best || score > best.score) {
      best = {
        outcomes,
        home,
        away,
        score,
        type: marketType,
        question: market.question || "",
      };
    }
  }

  return best;
}

function pickYesProbability(outcomes) {
  const yes = outcomes.find((o) => String(o.name).trim().toLowerCase() === "yes");
  return yes && Number.isFinite(Number(yes.probability))
    ? Number(yes.probability)
    : null;
}

function toUtcDateOnly(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function extractQuestionDate(question) {
  const match = String(question || "").match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return match ? match[1] : null;
}

function questionImpliesTeamWin(question, teamName, options = {}) {
  const q = String(question || "").trim();
  if (!q || !teamName) {
    return false;
  }

  const questionDate = extractQuestionDate(q);
  const referenceDates = Array.isArray(options.referenceDates)
    ? options.referenceDates.map((value) => toUtcDateOnly(value)).filter(Boolean)
    : [];
  if (
    questionDate &&
    options.requireQuestionDateMatch &&
    !referenceDates.includes(questionDate)
  ) {
    return false;
  }

  const hasWinWord = /\b(win|beat|defeat)\b/i.test(q);
  if (!hasWinWord) {
    return false;
  }

  const cleaned = q
    .replace(/^will\s+/i, "")
    .replace(/\s+(win|beat|defeat).*$/i, "")
    .trim();

  if (!cleaned) {
    return false;
  }

  const directSimilarity = teamSimilarity(cleaned, teamName);
  const wholeSimilarity = teamSimilarity(q, teamName);
  return Math.max(directSimilarity, wholeSimilarity) >= 0.5;
}

function pickTeamProbabilityFromYesNoMarkets(event, teamName, compareConfig, options = {}) {
  const markets = Array.isArray(event.markets) ? event.markets : [];
  for (const market of markets) {
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    const marketType = classifyQuestion(event.title, market.question, outcomes);
    const marketRule = getCompareMarketRule(marketType, compareConfig);
    if (
      !outcomes.length ||
      marketType !== "yes_no_team_win" ||
      !marketRule ||
      !questionImpliesTeamWin(market.question, teamName, {
        referenceDates: options.referenceDates,
        requireQuestionDateMatch: Boolean(marketRule.requireQuestionDateMatch),
      })
    ) {
      continue;
    }

    const p = pickYesProbability(outcomes);
    if (p !== null) {
      return {
        probability: p,
        type: marketType,
        question: market.question || "",
      };
    }
  }
  return null;
}

function getCompareLimit() {
  const raw = String(process.env.COMPARE_LIMIT || "30").trim().toLowerCase();
  if (!raw) {
    return 30;
  }

  if (raw === "all" || raw === "0") {
    return Infinity;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30;
  }

  return Math.floor(parsed);
}

function formatPct(x) {
  if (!Number.isFinite(x)) {
    return "-";
  }
  return `${(x * 100).toFixed(2)}%`;
}

function main() {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "sportbets.db");
  const pmPath = process.env.POLYMARKET_EVENTS_FILE || path.join(process.cwd(), "data", "polymarket_events.jsonl");

  const db = new Database(dbPath, { readonly: true });
  try {
    const events = readJsonl(pmPath).filter(
      (e) => Array.isArray(e.markets) && e.markets.length > 0
    );
    const compareConfig = loadCompareMarketCrosswalk();
    const compareLimit = getCompareLimit();
    const games = getDbGames(db, {
      sportKeys: process.env.COMPARE_SPORT_KEYS || "",
    });

    const rows = [];
    const seen = new Set();
    for (const event of events) {
      const matched = findBestGameMatch(event, games);
      if (!matched) {
        continue;
      }

      const odds = getBestOdds(db, matched.game.game_id);
      if (!odds) {
        continue;
      }

      const bestMarket = pickBestMarketForTeams(
        event,
        odds.home_team,
        odds.away_team,
        compareConfig
      );
      let pmHome = bestMarket && bestMarket.score >= 0.5 ? bestMarket.home : null;
      let pmAway = bestMarket && bestMarket.score >= 0.5 ? bestMarket.away : null;
      let marketType = bestMarket ? bestMarket.type : null;
      let marketQuestion = bestMarket ? bestMarket.question : null;
      const referenceDates = [matched.game.commence_time];

      // Many Polymarket sports events provide separate yes/no markets:
      // "Will Team A win?" and "Will Team B win?".
      if (pmHome === null) {
        const homeMarket = pickTeamProbabilityFromYesNoMarkets(
          event,
          odds.home_team,
          compareConfig,
          { referenceDates }
        );
        pmHome = homeMarket ? homeMarket.probability : null;
        if (!marketType && homeMarket) {
          marketType = homeMarket.type;
          marketQuestion = homeMarket.question;
        }
      }
      if (pmAway === null) {
        const awayMarket = pickTeamProbabilityFromYesNoMarkets(
          event,
          odds.away_team,
          compareConfig,
          { referenceDates }
        );
        pmAway = awayMarket ? awayMarket.probability : null;
        if (!marketType && awayMarket) {
          marketType = awayMarket.type;
          marketQuestion = awayMarket.question;
        }
      }

      if (pmHome === null || pmAway === null) {
        continue;
      }

      const oddsHome = impliedProbFromDecimal(odds.home_best);
      const oddsAway = impliedProbFromDecimal(odds.away_best);
      if (oddsHome === null || oddsAway === null) {
        continue;
      }

      const dedupeKey = `${event.id}::${matched.game.game_id}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      rows.push({
        polymarket_event_id: event.id,
        sport: matched.game.sport_title,
        game: `${matched.game.away_team} @ ${matched.game.home_team}`,
        start: matched.game.commence_time,
        pm_home: pmHome,
        odds_home: oddsHome,
        edge_home_pp: (pmHome - oddsHome) * 100,
        pm_away: pmAway,
        odds_away: oddsAway,
        edge_away_pp: (pmAway - oddsAway) * 100,
        market_question: marketQuestion || "yes_no_team_markets",
        market_type: marketType || "yes_no_team_win",
        match_score: matched.score,
      });
    }

    rows.sort((a, b) => Math.abs(b.edge_home_pp) + Math.abs(b.edge_away_pp) - (Math.abs(a.edge_home_pp) + Math.abs(a.edge_away_pp)));

    if (!rows.length) {
      console.log("No directly comparable Polymarket vs Odds events found.");
      return;
    }

    console.log("| Sport | Match | Start (UTC) | PM Type | Polymarket Market | PM Home | Odds Home | Delta Home | PM Away | Odds Away | Delta Away |");
    console.log("|---|---|---|---|---|---:|---:|---:|---:|---:|---:|");
    const visibleRows = Number.isFinite(compareLimit)
      ? rows.slice(0, compareLimit)
      : rows;
    for (const r of visibleRows) {
      const dh = `${r.edge_home_pp >= 0 ? "+" : ""}${r.edge_home_pp.toFixed(2)}pp`;
      const da = `${r.edge_away_pp >= 0 ? "+" : ""}${r.edge_away_pp.toFixed(2)}pp`;
      console.log(`| ${r.sport} | ${r.game} | ${r.start} | ${r.market_type} | ${r.market_question} | ${formatPct(r.pm_home)} | ${formatPct(r.odds_home)} | ${dh} | ${formatPct(r.pm_away)} | ${formatPct(r.odds_away)} | ${da} |`);
    }
  } finally {
    db.close();
  }
}

main();
