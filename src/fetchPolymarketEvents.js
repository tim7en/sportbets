require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { parseMatchTeams } = require("./nameMatch");

const DEFAULT_BASE_URL = "https://gamma-api.polymarket.com";

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }

  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) {
    return null;
  }

  return d.toISOString();
}

function normalizeCategory(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function buildOutputEvent(event) {
  const firstMarket = Array.isArray(event.markets) && event.markets.length
    ? event.markets[0]
    : null;

  const simplifiedMarkets = Array.isArray(event.markets)
    ? event.markets
        .map((m) => {
          let outcomes = [];
          try {
            const names = JSON.parse(m.outcomes || "[]");
            const prices = JSON.parse(m.outcomePrices || "[]");
            if (Array.isArray(names) && Array.isArray(prices)) {
              outcomes = names
                .map((name, i) => ({
                  name: String(name || "").trim(),
                  probability: Number(prices[i] || 0),
                }))
                .filter((x) => x.name && Number.isFinite(x.probability));
            }
          } catch {
            outcomes = [];
          }

          return {
            id: String(m.id || "").trim(),
            question: String(m.question || "").trim(),
            outcomes,
          };
        })
        .filter((m) => m.outcomes.length > 0)
    : [];

  return {
    id: String(event.id || event.slug || "").trim(),
    title: String(event.title || firstMarket?.question || "").trim(),
    slug: event.slug || null,
    sport: event.series?.[0]?.title || event.category || null,
    category: event.category || null,
    start_time: toIsoOrNull(event.startDate || firstMarket?.startDate),
    end_time: toIsoOrNull(event.endDate || firstMarket?.endDate),
    active: Boolean(event.active),
    closed: Boolean(event.closed),
    archived: Boolean(event.archived),
    liquidity: Number(event.liquidityClob || event.liquidity || 0),
    volume: Number(event.volume24hr || event.volume || 0),
    market: firstMarket
      ? {
          id: String(firstMarket.id || ""),
          question: String(firstMarket.question || "").trim(),
        }
      : null,
    markets: simplifiedMarkets,
  };
}

async function fetchEventsPage(baseUrl, params) {
  const url = new URL("/events", baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Polymarket Gamma error ${res.status} ${res.statusText}: ${body.slice(0, 300)}`
    );
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchPolymarketEvents(config) {
  const pageSize = Number(config.pageSize || 100);
  const maxPages = Number(config.maxPages || 10);
  const minLiquidity = Number(config.minLiquidity || 0);
  const minVolume = Number(config.minVolume || 0);
  const category = normalizeCategory(config.category || "");
  const requireMatchTitle = String(config.requireMatchTitle || "false") === "true";

  const all = [];
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;

    const pageRows = await fetchEventsPage(config.baseUrl, {
      limit: pageSize,
      offset,
      active: true,
      closed: false,
      archived: false,
      order: "volume",
      ascending: false,
    });

    pagesFetched += 1;
    if (!pageRows.length) {
      break;
    }

    for (const row of pageRows) {
      const mapped = buildOutputEvent(row);
      if (!mapped.id || !mapped.title) {
        continue;
      }

      if (
        category &&
        !normalizeCategory(mapped.category).includes(category) &&
        !normalizeCategory(mapped.sport).includes(category)
      ) {
        continue;
      }

      if (requireMatchTitle && !parseMatchTeams(mapped.title)) {
        continue;
      }

      if (mapped.liquidity < minLiquidity || mapped.volume < minVolume) {
        continue;
      }

      all.push(mapped);
    }

    if (pageRows.length < pageSize) {
      break;
    }
  }

  const deduped = new Map();
  for (const event of all) {
    deduped.set(event.id, event);
  }

  return {
    events: Array.from(deduped.values()),
    pagesFetched,
  };
}

async function main() {
  const baseUrl = (process.env.POLYMARKET_BASE_URL || DEFAULT_BASE_URL).trim();
  const outFile = process.env.POLYMARKET_EVENTS_FILE || path.join(process.cwd(), "data", "polymarket_events.jsonl");

  const { events, pagesFetched } = await fetchPolymarketEvents({
    baseUrl,
    pageSize: process.env.POLYMARKET_PAGE_SIZE || 100,
    maxPages: process.env.POLYMARKET_MAX_PAGES || 10,
    category: process.env.POLYMARKET_CATEGORY || "",
    requireMatchTitle: process.env.POLYMARKET_REQUIRE_MATCH_TITLE || "false",
    minLiquidity: process.env.POLYMARKET_MIN_LIQUIDITY || 0,
    minVolume: process.env.POLYMARKET_MIN_VOLUME || 0,
  });

  const dir = path.dirname(outFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outFile, events.map((x) => JSON.stringify(x)).join("\n"));

  console.log(
    JSON.stringify(
      {
        status: "ok",
        outputFile: outFile,
        events: events.length,
        pagesFetched,
        baseUrl,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error("Failed to fetch Polymarket events:", err.message);
  process.exitCode = 1;
});
