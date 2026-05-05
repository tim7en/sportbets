const { URL } = require("url");

const DEFAULT_BASE_URL = "https://api.the-odds-api.com/v4";

function parseSportsFromEnv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isoNow() {
  return new Date().toISOString();
}

function toApiIsoNoMs(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function getTodayWindowUtc(now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);

  return {
    from: toApiIsoNoMs(start),
    to: toApiIsoNoMs(now),
  };
}

function isTodayUtc(isoDate, now = new Date()) {
  const d = new Date(isoDate);
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

function createOddsClient(config) {
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new Error("Missing ODDS_API in environment.");
  }

  const maxCalls = Number(config.maxCalls || 5);
  let callsUsed = 0;

  async function request(pathname, query = {}) {
    if (callsUsed >= maxCalls) {
      throw new Error(`API call limit reached: ${callsUsed}/${maxCalls}.`);
    }

    const url = new URL(`${config.baseUrl || DEFAULT_BASE_URL}${pathname}`);
    url.searchParams.set("apiKey", apiKey);

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const res = await fetch(url);
    callsUsed += 1;

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Odds API error ${res.status} ${res.statusText}: ${body.slice(0, 300)}`
      );
    }

    return res.json();
  }

  function getUsage() {
    return { callsUsed, maxCalls };
  }

  return { request, getUsage };
}

async function resolveSportsToFetch(client, config) {
  const envSports = parseSportsFromEnv(config.sports);
  if (envSports.length > 0) {
    return envSports;
  }

  const usage = client.getUsage();
  if (usage.callsUsed >= usage.maxCalls) {
    return [];
  }

  const allSports = await client.request("/sports");
  const remainingCalls = usage.maxCalls - client.getUsage().callsUsed;

  return allSports
    .filter((sport) => sport && sport.active && !sport.has_outrights)
    .map((sport) => sport.key)
    .slice(0, Math.max(0, remainingCalls));
}

async function fetchTodayGamesAndOdds(config) {
  const client = createOddsClient(config);
  const sports = await resolveSportsToFetch(client, config);
  const now = new Date();
  const todayWindow = getTodayWindowUtc(now);

  const results = [];
  for (const sportKey of sports) {
    const usage = client.getUsage();
    if (usage.callsUsed >= usage.maxCalls) {
      break;
    }

    let games = [];
    try {
      games = await client.request(`/sports/${sportKey}/odds`, {
        regions: config.regions || "us",
        markets: config.markets || "h2h",
        oddsFormat: config.oddsFormat || "decimal",
        dateFormat: config.dateFormat || "iso",
        commenceTimeFrom: todayWindow.from,
        commenceTimeTo: todayWindow.to,
      });
    } catch (err) {
      if (String(err.message || "").includes("INVALID_MARKET_COMBO")) {
        continue;
      }
      throw err;
    }

    for (const game of games) {
      if (!game || !game.id || !game.commence_time) {
        continue;
      }

      // The free API does not expose a strict live flag in this endpoint,
      // so we treat games that started today and before now as ongoing candidates.
      const commence = new Date(game.commence_time);
      if (!isTodayUtc(game.commence_time, now) || commence > now) {
        continue;
      }

      results.push({
        game_id: game.id,
        sport_key: game.sport_key || sportKey,
        sport_title: game.sport_title || sportKey,
        commence_time: game.commence_time,
        home_team: game.home_team || null,
        away_team: game.away_team || null,
        last_seen_at: isoNow(),
        bookmakers: Array.isArray(game.bookmakers) ? game.bookmakers : [],
      });
    }
  }

  return {
    games: results,
    usage: client.getUsage(),
  };
}

module.exports = {
  fetchTodayGamesAndOdds,
};
