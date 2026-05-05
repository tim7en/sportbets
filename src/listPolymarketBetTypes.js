require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  cleanText,
  getOutcomeShape,
  classifyQuestion,
} = require("./polymarketMarketTypes");

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