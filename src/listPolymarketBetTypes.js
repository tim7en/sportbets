require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { parseMatchTeams } = require("./nameMatch");

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

  if (
    names.length === 2 &&
    names.includes("yes") &&
    names.includes("no")
  ) {
    return "yes_no";
  }

  if (
    names.length === 2 &&
    names.includes("over") &&
    names.includes("under")
  ) {
    return "over_under";
  }

  return "named_sides";
}

function classifyQuestion(eventTitle, question, outcomes) {
  const title = cleanText(eventTitle);
  const q = cleanText(question);
  const lowered = q.toLowerCase();
  const shape = getOutcomeShape(outcomes);
  const hasSubperiodContext = /\b(1h|2h|1st half|2nd half|first half|second half|quarter|period)\b/i.test(q);

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

function addToSetMap(map, key, value) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }

  if (value) {
    map.get(key).add(value);
  }
}

function buildInventory(events) {
  const typeStats = new Map();
  const questionStats = new Map();
  let marketCount = 0;

  for (const event of events) {
    const sport = cleanText(event.sport || event.category || "unknown") || "unknown";
    const markets = Array.isArray(event.markets) ? event.markets : [];

    for (const market of markets) {
      const question = cleanText(market.question);
      const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
      const type = classifyQuestion(event.title, question, outcomes);
      const shape = getOutcomeShape(outcomes);
      marketCount += 1;

      if (!typeStats.has(type)) {
        typeStats.set(type, {
          type,
          count: 0,
          sports: new Set(),
          questions: new Set(),
        });
      }

      const typeRow = typeStats.get(type);
      typeRow.count += 1;
      typeRow.sports.add(sport);
      if (question) {
        typeRow.questions.add(question);
      }

      if (!questionStats.has(question)) {
        questionStats.set(question, {
          question,
          type,
          count: 0,
          sports: new Set(),
          outcomeShapes: new Set(),
        });
      }

      const questionRow = questionStats.get(question);
      questionRow.count += 1;
      questionRow.sports.add(sport);
      questionRow.outcomeShapes.add(shape);
    }
  }

  return {
    eventCount: events.length,
    marketCount,
    uniqueQuestions: questionStats.size,
    marketTypes: Array.from(typeStats.values())
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
      .map((row) => ({
        type: row.type,
        count: row.count,
        sports: Array.from(row.sports).sort(),
        sampleQuestions: Array.from(row.questions).sort().slice(0, 10),
      })),
    exactQuestions: Array.from(questionStats.values())
      .sort((a, b) => b.count - a.count || a.question.localeCompare(b.question))
      .map((row) => ({
        question: row.question,
        type: row.type,
        count: row.count,
        sports: Array.from(row.sports).sort(),
        outcomeShapes: Array.from(row.outcomeShapes).sort(),
      })),
  };
}

function main() {
  const inputFile =
    process.env.POLYMARKET_EVENTS_FILE ||
    path.join(process.cwd(), "data", "polymarket_events.jsonl");
  const outputFile =
    process.env.POLYMARKET_BET_TYPES_FILE ||
    path.join(process.cwd(), "data", "polymarket_bet_types.json");

  const events = readJsonl(inputFile).filter(
    (event) => Array.isArray(event.markets) && event.markets.length > 0
  );

  const inventory = buildInventory(events);
  const output = {
    generated_at: new Date().toISOString(),
    input_file: inputFile,
    output_file: outputFile,
    ...inventory,
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

  console.log(
    JSON.stringify(
      {
        status: "ok",
        inputFile,
        outputFile,
        events: output.eventCount,
        markets: output.marketCount,
        uniqueQuestions: output.uniqueQuestions,
        marketTypes: output.marketTypes.map((row) => ({
          type: row.type,
          count: row.count,
        })),
      },
      null,
      2
    )
  );
}

main();