require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { parseMatchTeams, teamSimilarity } = require("./nameMatch");
const { classifyQuestion } = require("./polymarketMarketTypes");

const LINE_EPSILON = 0.001;

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

function getBestTotalOdds(db, gameId, line) {
  const row = db
    .prepare(
      `
      SELECT
        MAX(CASE WHEN lower(outcome_name) = 'over' AND ABS(point - ?) < ? THEN price END) AS over_best,
        MAX(CASE WHEN lower(outcome_name) = 'under' AND ABS(point - ?) < ? THEN price END) AS under_best
      FROM odds
      WHERE game_id = ? AND market_key = 'totals'
    `
    )
    .get(line, LINE_EPSILON, line, LINE_EPSILON, gameId);

  if (!row || !row.over_best || !row.under_best) {
    return null;
  }

  return row;
}

function getBestSpreadOdds(db, gameId, selections) {
  const outcomeNames = Object.keys(selections || {});
  if (outcomeNames.length !== 2) {
    return null;
  }

  const firstName = outcomeNames[0];
  const secondName = outcomeNames[1];
  const firstPoint = selections[firstName];
  const secondPoint = selections[secondName];

  const row = db
    .prepare(
      `
      SELECT
        MAX(CASE WHEN lower(outcome_name) = lower(?) AND ABS(point - ?) < ? THEN price END) AS first_best,
        MAX(CASE WHEN lower(outcome_name) = lower(?) AND ABS(point - ?) < ? THEN price END) AS second_best
      FROM odds
      WHERE game_id = ? AND market_key = 'spreads'
    `
    )
    .get(
      firstName,
      firstPoint,
      LINE_EPSILON,
      secondName,
      secondPoint,
      LINE_EPSILON,
      gameId
    );

  if (!row || !row.first_best || !row.second_best) {
    return null;
  }

  return {
    [firstName]: row.first_best,
    [secondName]: row.second_best,
  };
}

function impliedProbFromDecimal(odds) {
  const x = Number(odds);
  if (!Number.isFinite(x) || x <= 1) {
    return null;
  }
  return 1 / x;
}

function resolveComparableMarketType(event, market) {
  const sportsMarketType = String(market.sportsMarketType || "")
    .trim()
    .toLowerCase();
  const classifiedType = classifyQuestion(
    event.title,
    market.question,
    Array.isArray(market.outcomes) ? market.outcomes : []
  );

  if (classifiedType === "yes_no_team_win") {
    return "yes_no_team_win";
  }
  if (sportsMarketType === "moneyline" || classifiedType === "match_winner") {
    return "match_winner";
  }
  if (
    sportsMarketType === "totals" ||
    classifiedType === "total_over_under" ||
    classifiedType === "match_total_over_under"
  ) {
    return "total_over_under";
  }
  if (sportsMarketType === "spreads") {
    return "spread";
  }

  return classifiedType;
}

function isActionablePolymarketMarket(event, market) {
  const includeInPlay = String(process.env.COMPARE_INCLUDE_INPLAY || "false")
    .trim()
    .toLowerCase() === "true";

  if (!market || market.archived || market.closed || market.acceptingOrders === false) {
    return false;
  }

  if (includeInPlay) {
    return market.active !== false;
  }

  const startTime = new Date(
    market.gameStartTime || event.start_time || event.end_time || 0
  ).getTime();
  if (Number.isFinite(startTime) && startTime <= Date.now()) {
    return false;
  }

  return market.active !== false;
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
    const marketType = resolveComparableMarketType(event, market);
    if (
      marketType !== "match_winner" ||
      !isAllowedCompareMarketType(marketType, allowedMarketTypes) ||
      !isActionablePolymarketMarket(event, market)
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

function pickOverUnderProbabilities(outcomes) {
  const over = (outcomes || []).find(
    (outcome) => String(outcome.name || "").trim().toLowerCase() === "over"
  );
  const under = (outcomes || []).find(
    (outcome) => String(outcome.name || "").trim().toLowerCase() === "under"
  );

  if (!over || !under) {
    return null;
  }

  const overProbability = Number(over.probability);
  const underProbability = Number(under.probability);
  if (!Number.isFinite(overProbability) || !Number.isFinite(underProbability)) {
    return null;
  }

  return {
    Over: overProbability,
    Under: underProbability,
  };
}

function parseSignedPointEntries(question) {
  const cleaned = String(question || "").replace(/\s+/g, " ").trim();
  const entries = [];
  const regex = /([^()]+?)\s*\(([+-]?\d+(?:\.\d+)?)\)/g;
  let match;

  while ((match = regex.exec(cleaned))) {
    const rawLabel = String(match[1] || "")
      .replace(/^.*?:\s*/g, "")
      .replace(/\bvs\b\s*$/i, "")
      .trim();
    const point = Number(match[2]);
    if (!rawLabel || !Number.isFinite(point)) {
      continue;
    }
    entries.push({
      label: rawLabel,
      point,
    });
  }

  return entries;
}

function mapSpreadOutcomePoints(question, outcomes) {
  const namedOutcomes = (outcomes || []).filter((outcome) => outcome.name);
  if (namedOutcomes.length !== 2) {
    return null;
  }

  const entries = parseSignedPointEntries(question);
  const mapped = {};

  for (const entry of entries) {
    let best = null;
    for (const outcome of namedOutcomes) {
      const score = teamSimilarity(entry.label, outcome.name);
      if (!best || score > best.score) {
        best = { outcomeName: outcome.name, score };
      }
    }

    if (best && best.score >= 0.5) {
      mapped[best.outcomeName] = entry.point;
    }
  }

  if (Object.keys(mapped).length === 1 && entries.length === 1) {
    const firstName = Object.keys(mapped)[0];
    const secondName = namedOutcomes.find((outcome) => outcome.name !== firstName).name;
    mapped[secondName] = -mapped[firstName];
  }

  return Object.keys(mapped).length === 2 ? mapped : null;
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
      !isActionablePolymarketMarket(event, market) ||
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

function buildNamedSidesRow(event, market, matched, odds, marketType) {
  const pmHome = pickPolymarketSideProbability(market.outcomes, odds.home_team);
  const pmAway = pickPolymarketSideProbability(market.outcomes, odds.away_team);
  if (pmHome === null || pmAway === null) {
    return null;
  }

  const oddsHome = impliedProbFromDecimal(odds.home_best);
  const oddsAway = impliedProbFromDecimal(odds.away_best);
  if (oddsHome === null || oddsAway === null) {
    return null;
  }

  return {
    polymarket_event_id: event.id,
    polymarket_market_id: market.id || marketType,
    sport: matched.game.sport_title,
    game: `${matched.game.away_team} @ ${matched.game.home_team}`,
    start: matched.game.commence_time,
    market_type: marketType,
    market_question: market.question || "",
    market_line: market.line ?? null,
    side_a_label: odds.home_team,
    pm_a: pmHome,
    odds_a: oddsHome,
    edge_a_pp: (pmHome - oddsHome) * 100,
    side_b_label: odds.away_team,
    pm_b: pmAway,
    odds_b: oddsAway,
    edge_b_pp: (pmAway - oddsAway) * 100,
    match_score: matched.score,
  };
}

function buildOverUnderRow(event, market, matched) {
  const probabilities = pickOverUnderProbabilities(market.outcomes);
  if (!probabilities || !Number.isFinite(Number(market.line))) {
    return null;
  }

  const odds = getBestTotalOdds(dbHandle, matched.game.game_id, Number(market.line));
  if (!odds) {
    return null;
  }

  const oddsOver = impliedProbFromDecimal(odds.over_best);
  const oddsUnder = impliedProbFromDecimal(odds.under_best);
  if (oddsOver === null || oddsUnder === null) {
    return null;
  }

  return {
    polymarket_event_id: event.id,
    polymarket_market_id: market.id || "total_over_under",
    sport: matched.game.sport_title,
    game: `${matched.game.away_team} @ ${matched.game.home_team}`,
    start: matched.game.commence_time,
    market_type: "total_over_under",
    market_question: market.question || "",
    market_line: Number(market.line),
    side_a_label: "Over",
    pm_a: probabilities.Over,
    odds_a: oddsOver,
    edge_a_pp: (probabilities.Over - oddsOver) * 100,
    side_b_label: "Under",
    pm_b: probabilities.Under,
    odds_b: oddsUnder,
    edge_b_pp: (probabilities.Under - oddsUnder) * 100,
    match_score: matched.score,
  };
}

function buildSpreadRow(event, market, matched) {
  const outcomePoints = mapSpreadOutcomePoints(market.question, market.outcomes);
  if (!outcomePoints) {
    return null;
  }

  const odds = getBestSpreadOdds(dbHandle, matched.game.game_id, outcomePoints);
  if (!odds) {
    return null;
  }

  const outcomeNames = Object.keys(outcomePoints);
  const firstName = outcomeNames[0];
  const secondName = outcomeNames[1];
  const pmFirst = pickPolymarketSideProbability(market.outcomes, firstName);
  const pmSecond = pickPolymarketSideProbability(market.outcomes, secondName);
  if (pmFirst === null || pmSecond === null) {
    return null;
  }

  const oddsFirst = impliedProbFromDecimal(odds[firstName]);
  const oddsSecond = impliedProbFromDecimal(odds[secondName]);
  if (oddsFirst === null || oddsSecond === null) {
    return null;
  }

  return {
    polymarket_event_id: event.id,
    polymarket_market_id: market.id || "spread",
    sport: matched.game.sport_title,
    game: `${matched.game.away_team} @ ${matched.game.home_team}`,
    start: matched.game.commence_time,
    market_type: "spread",
    market_question: market.question || "",
    market_line: Number(market.line),
    side_a_label: `${firstName} (${outcomePoints[firstName] > 0 ? "+" : ""}${outcomePoints[firstName]})`,
    pm_a: pmFirst,
    odds_a: oddsFirst,
    edge_a_pp: (pmFirst - oddsFirst) * 100,
    side_b_label: `${secondName} (${outcomePoints[secondName] > 0 ? "+" : ""}${outcomePoints[secondName]})`,
    pm_b: pmSecond,
    odds_b: oddsSecond,
    edge_b_pp: (pmSecond - oddsSecond) * 100,
    match_score: matched.score,
  };
}

function formatPct(x) {
  if (!Number.isFinite(x)) {
    return "-";
  }
  return `${(x * 100).toFixed(2)}%`;
}

let dbHandle = null;

function main() {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "sportbets.db");
  const pmPath = process.env.POLYMARKET_EVENTS_FILE || path.join(process.cwd(), "data", "polymarket_events.jsonl");

  const db = new Database(dbPath, { readonly: true });
  dbHandle = db;
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

      const bestMoneylineMarket = pickBestMarketForTeams(
        event,
        odds.home_team,
        odds.away_team,
        compareConfig
      );
      if (bestMoneylineMarket && bestMoneylineMarket.score >= 0.5) {
        const moneylineRow = buildNamedSidesRow(
          event,
          bestMoneylineMarket,
          matched,
          odds,
          "match_winner"
        );
        if (moneylineRow) {
          const dedupeKey = `${event.id}::${matched.game.game_id}::${moneylineRow.polymarket_market_id}`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            rows.push(moneylineRow);
          }
        }
      }

      for (const market of event.markets || []) {
        const marketType = resolveComparableMarketType(event, market);
        const rule = getCompareMarketRule(marketType, compareConfig);
        if (
          !rule ||
          marketType === "match_winner" ||
          marketType === "yes_no_team_win" ||
          !isActionablePolymarketMarket(event, market)
        ) {
          continue;
        }

        let row = null;
        if (rule.comparisonStrategy === "over_under_line") {
          row = buildOverUnderRow(event, market, matched);
        } else if (rule.comparisonStrategy === "named_sides_line") {
          row = buildSpreadRow(event, market, matched);
        }

        if (!row) {
          continue;
        }

        const dedupeKey = `${event.id}::${matched.game.game_id}::${row.polymarket_market_id}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        rows.push(row);
      }

      let pmHome = null;
      let pmAway = null;
      let marketType = null;
      let marketQuestion = null;
      const referenceDates = [matched.game.commence_time];

      // Many Polymarket sports events provide separate yes/no markets:
      // "Will Team A win?" and "Will Team B win?".
      if (getCompareMarketRule("yes_no_team_win", compareConfig)) {
        const homeMarket = pickTeamProbabilityFromYesNoMarkets(
          event,
          odds.home_team,
          compareConfig,
          { referenceDates }
        );
        pmHome = homeMarket ? homeMarket.probability : null;
        if (homeMarket) {
          marketType = homeMarket.type;
          marketQuestion = homeMarket.question;
        }
        const awayMarket = pickTeamProbabilityFromYesNoMarkets(
          event,
          odds.away_team,
          compareConfig,
          { referenceDates }
        );
        pmAway = awayMarket ? awayMarket.probability : null;
      }

      if (pmHome !== null && pmAway !== null) {
        const oddsHome = impliedProbFromDecimal(odds.home_best);
        const oddsAway = impliedProbFromDecimal(odds.away_best);
        if (oddsHome !== null && oddsAway !== null) {
          const dedupeKey = `${event.id}::${matched.game.game_id}::yes_no_team_win`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            rows.push({
              polymarket_event_id: event.id,
              polymarket_market_id: "yes_no_team_win",
              sport: matched.game.sport_title,
              game: `${matched.game.away_team} @ ${matched.game.home_team}`,
              start: matched.game.commence_time,
              market_type: marketType || "yes_no_team_win",
              market_question: marketQuestion || "yes_no_team_markets",
              market_line: null,
              side_a_label: odds.home_team,
              pm_a: pmHome,
              odds_a: oddsHome,
              edge_a_pp: (pmHome - oddsHome) * 100,
              side_b_label: odds.away_team,
              pm_b: pmAway,
              odds_b: oddsAway,
              edge_b_pp: (pmAway - oddsAway) * 100,
              match_score: matched.score,
            });
          }
        }
      }
    }

    rows.sort(
      (a, b) =>
        Math.max(Math.abs(b.edge_a_pp), Math.abs(b.edge_b_pp)) -
        Math.max(Math.abs(a.edge_a_pp), Math.abs(a.edge_b_pp))
    );

    if (!rows.length) {
      console.log("No directly comparable Polymarket vs Odds events found.");
      return;
    }

    console.log("| Sport | Match | Start (UTC) | PM Type | Line | Polymarket Market | Outcome A | PM A | Odds A | Delta A | Outcome B | PM B | Odds B | Delta B |");
    console.log("|---|---|---|---|---:|---|---|---:|---:|---:|---|---:|---:|---:|");
    const visibleRows = Number.isFinite(compareLimit)
      ? rows.slice(0, compareLimit)
      : rows;
    for (const r of visibleRows) {
      const da = `${r.edge_a_pp >= 0 ? "+" : ""}${r.edge_a_pp.toFixed(2)}pp`;
      const dbDelta = `${r.edge_b_pp >= 0 ? "+" : ""}${r.edge_b_pp.toFixed(2)}pp`;
      const line = r.market_line === null || r.market_line === undefined ? "" : Number(r.market_line);
      console.log(`| ${r.sport} | ${r.game} | ${r.start} | ${r.market_type} | ${line} | ${r.market_question} | ${r.side_a_label} | ${formatPct(r.pm_a)} | ${formatPct(r.odds_a)} | ${da} | ${r.side_b_label} | ${formatPct(r.pm_b)} | ${formatPct(r.odds_b)} | ${dbDelta} |`);
    }
  } finally {
    db.close();
    dbHandle = null;
  }
}

main();
