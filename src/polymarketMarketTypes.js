const { parseMatchTeams } = require("./nameMatch");

const DEFAULT_COMPARE_MARKET_TYPES = ["match_winner", "yes_no_team_win"];

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

function looksLikeHeadToHead(value) {
  return /\s+vs\.?\s+|\s+v\s+|\s+@\s+/i.test(cleanText(value));
}

function getOutcomeShape(outcomes) {
  const names = (Array.isArray(outcomes) ? outcomes : []).map((outcome) =>
    cleanText(outcome.name).toLowerCase()
  );

  if (!names.length) {
    return "none";
  }

  if (names.length === 2 && names.includes("yes") && names.includes("no")) {
    return "yes_no";
  }

  if (names.length === 2 && names.includes("over") && names.includes("under")) {
    return "over_under";
  }

  return "named_sides";
}

function classifyQuestion(eventTitle, question, outcomes) {
  const title = cleanText(eventTitle);
  const q = cleanText(question);
  const shape = getOutcomeShape(outcomes);
  const hasSubperiodContext =
    /\b(1h|2h|1st half|2nd half|first half|second half|quarter|period)\b/i.test(
      q
    );

  if (!q) {
    return "blank";
  }

  if (
    shape === "yes_no" &&
    /\b(will|can|does)\b/i.test(q) &&
    /\b(win|beat|defeat)\b/i.test(q)
  ) {
    return "yes_no_team_win";
  }

  if (/\bup or down\b/i.test(q)) {
    return "directional_binary";
  }

  if (/both teams to score/i.test(q)) {
    return "both_teams_prop";
  }

  if (hasSubperiodContext && /moneyline/i.test(q)) {
    return "partial_moneyline";
  }

  if (
    (normalizeText(q) === normalizeText(title) && looksLikeHeadToHead(q)) ||
    (looksLikeHeadToHead(q) &&
      parseMatchTeams(q) &&
      /\b(winner|moneyline)\b/i.test(q) &&
      !hasSubperiodContext &&
      !/\b(game|map|set)\s+\d+\b/i.test(q) &&
      !/over\/under|\bo\/?u\b|handicap|odd\/even|both teams to score/i.test(q))
  ) {
    return "match_winner";
  }

  if (/\bset\s+\d+\s+winner\b|\bset winner\b/i.test(q)) {
    return "set_winner";
  }

  if (/\bmap\s+\d+\s+winner\b|\bmap winner\b/i.test(q)) {
    return "map_winner";
  }

  if (/\bgame\s+\d+\s+winner\b|\bgame winner\b/i.test(q)) {
    return "game_winner";
  }

  if (/set handicap/i.test(q)) {
    return "set_handicap";
  }

  if (/game handicap|map handicap/i.test(q)) {
    return "submatch_handicap";
  }

  if (/handicap/i.test(q)) {
    return "handicap";
  }

  if (/odd\/even/i.test(q)) {
    return "odd_even_total";
  }

  if (/both teams/i.test(q)) {
    return "both_teams_prop";
  }

  if (/any player/i.test(q)) {
    return "player_achievement";
  }

  if (/ends in daytime/i.test(q)) {
    return "time_state_prop";
  }

  if (/roshan|dragon|baron nashor|barracks|inhibitors/i.test(q)) {
    return "objective_prop";
  }

  if (/total sets/i.test(q)) {
    return "match_total_sets";
  }

  if (/games total:\s*o\/?u/i.test(q)) {
    return "series_games_total_over_under";
  }

  if (/total kills over\/under/i.test(q)) {
    return "kills_total_over_under";
  }

  if (/match\s+o\/?u/i.test(q)) {
    return "match_total_over_under";
  }

  if (/set\s+\d+\s+games\s+o\/?u/i.test(q)) {
    return "set_games_over_under";
  }

  if (/over\/under|\bo\/?u\b/i.test(q)) {
    return "total_over_under";
  }

  if (shape === "yes_no") {
    return "yes_no_prop";
  }

  return "other";
}

function parseAllowedMarketTypes(value) {
  const raw = String(value || "").trim();
  const items = raw
    ? raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : DEFAULT_COMPARE_MARKET_TYPES;

  return new Set(items);
}

function isAllowedCompareMarketType(type, allowedMarketTypes) {
  return (allowedMarketTypes || parseAllowedMarketTypes()).has(type);
}

module.exports = {
  DEFAULT_COMPARE_MARKET_TYPES,
  cleanText,
  normalizeText,
  looksLikeHeadToHead,
  getOutcomeShape,
  classifyQuestion,
  parseAllowedMarketTypes,
  isAllowedCompareMarketType,
};