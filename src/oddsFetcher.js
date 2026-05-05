const { URL } = require("url");

const DEFAULT_BASE_URL = "https://api.the-odds-api.com/v4";

function parseCsvFromEnv(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSportsFromEnv(value) {
  return parseCsvFromEnv(value);
}

function parseMarketsFromEnv(value) {
  const parsed = parseCsvFromEnv(value);
  return parsed.length > 0 ? parsed : ["h2h"];
}

function isoNow() {
  return new Date().toISOString();
}

function toApiIsoNoMs(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function getTomorrowEndUtc(now = new Date()) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(23, 59, 59, 0);
  return d;
}

function getEndOfNextWeekUtc(now = new Date()) {
  const currentDay = now.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const daysUntilSunday = (7 - currentDay) % 7;

  const end = new Date(now);
  end.setUTCDate(now.getUTCDate() + daysUntilSunday + 7);
  end.setUTCHours(23, 59, 59, 0);
  return end;
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

function getPlannedWindowTodayTomorrowUtc(now = new Date()) {
  return {
    from: toApiIsoNoMs(now),
    to: toApiIsoNoMs(getTomorrowEndUtc(now)),
  };
}

function getPlannedWindowThisAndNextWeekUtc(now = new Date()) {
  return {
    from: toApiIsoNoMs(now),
    to: toApiIsoNoMs(getEndOfNextWeekUtc(now)),
  };
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

function cloneOutcome(outcome) {
  return {
    ...outcome,
  };
}

function cloneMarket(market) {
  return {
    ...market,
    outcomes: Array.isArray(market.outcomes)
      ? market.outcomes.map(cloneOutcome)
      : [],
  };
}

function cloneBookmaker(bookmaker) {
  return {
    ...bookmaker,
    markets: Array.isArray(bookmaker.markets)
      ? bookmaker.markets.map(cloneMarket)
      : [],
  };
}

function cloneGame(game) {
  return {
    ...game,
    bookmakers: Array.isArray(game.bookmakers)
      ? game.bookmakers.map(cloneBookmaker)
      : [],
  };
}

function mergeBookmakerMarkets(targetBookmaker, incomingBookmaker) {
  targetBookmaker.title = incomingBookmaker.title || targetBookmaker.title;
  targetBookmaker.last_update =
    incomingBookmaker.last_update || targetBookmaker.last_update || null;

  const marketMap = new Map(
    (targetBookmaker.markets || []).map((market) => [market.key, market])
  );

  for (const incomingMarket of incomingBookmaker.markets || []) {
    const existingMarket = marketMap.get(incomingMarket.key);
    if (!existingMarket) {
      const cloned = cloneMarket(incomingMarket);
      targetBookmaker.markets.push(cloned);
      marketMap.set(cloned.key, cloned);
      continue;
    }

    existingMarket.last_update =
      incomingMarket.last_update || existingMarket.last_update || null;
    const outcomeMap = new Map(
      (existingMarket.outcomes || []).map((outcome) => [
        `${String(outcome.name || "")}::${String(outcome.point ?? "")}`,
        outcome,
      ])
    );

    for (const incomingOutcome of incomingMarket.outcomes || []) {
      const outcomeKey = `${String(incomingOutcome.name || "")}::${String(
        incomingOutcome.point ?? ""
      )}`;
      if (!outcomeMap.has(outcomeKey)) {
        existingMarket.outcomes.push(cloneOutcome(incomingOutcome));
        continue;
      }

      Object.assign(outcomeMap.get(outcomeKey), cloneOutcome(incomingOutcome));
    }
  }
}

function mergeGames(existingGame, incomingGame) {
  existingGame.sport_key = incomingGame.sport_key || existingGame.sport_key;
  existingGame.sport_title = incomingGame.sport_title || existingGame.sport_title;
  existingGame.commence_time = incomingGame.commence_time || existingGame.commence_time;
  existingGame.home_team = incomingGame.home_team || existingGame.home_team;
  existingGame.away_team = incomingGame.away_team || existingGame.away_team;
  existingGame.last_seen_at = incomingGame.last_seen_at || existingGame.last_seen_at;

  const bookmakerMap = new Map(
    (existingGame.bookmakers || []).map((bookmaker) => [bookmaker.key, bookmaker])
  );

  for (const incomingBookmaker of incomingGame.bookmakers || []) {
    const existingBookmaker = bookmakerMap.get(incomingBookmaker.key);
    if (!existingBookmaker) {
      const cloned = cloneBookmaker(incomingBookmaker);
      existingGame.bookmakers.push(cloned);
      bookmakerMap.set(cloned.key, cloned);
      continue;
    }

    mergeBookmakerMarkets(existingBookmaker, incomingBookmaker);
  }
}

function buildMarketVariants(marketsValue) {
  const markets = parseMarketsFromEnv(marketsValue);
  if (markets.length <= 1) {
    return [markets];
  }

  return [markets, ...markets.map((marketKey) => [marketKey])];
}

async function fetchSportGames(client, sportKey, config, window) {
  const variants = buildMarketVariants(config.markets || "h2h");
  const mergedGames = new Map();

  for (const marketKeys of variants) {
    const usage = client.getUsage();
    if (usage.callsUsed >= usage.maxCalls) {
      break;
    }

    let games = [];
    try {
      games = await client.request(`/sports/${sportKey}/odds`, {
        regions: config.regions || "us",
        markets: marketKeys.join(","),
        oddsFormat: config.oddsFormat || "decimal",
        dateFormat: config.dateFormat || "iso",
        commenceTimeFrom: window.from,
        commenceTimeTo: window.to,
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

      const normalized = {
        game_id: game.id,
        sport_key: game.sport_key || sportKey,
        sport_title: game.sport_title || sportKey,
        commence_time: game.commence_time,
        home_team: game.home_team || null,
        away_team: game.away_team || null,
        last_seen_at: isoNow(),
        bookmakers: Array.isArray(game.bookmakers) ? game.bookmakers : [],
      };

      if (!mergedGames.has(normalized.game_id)) {
        mergedGames.set(normalized.game_id, cloneGame(normalized));
        continue;
      }

      mergeGames(mergedGames.get(normalized.game_id), normalized);
    }

    if (variants[0] === marketKeys) {
      break;
    }
  }

  return Array.from(mergedGames.values());
}

async function fetchTodayGamesAndOdds(config) {
  const client = createOddsClient(config);
  const sports = await resolveSportsToFetch(client, config);
  const now = new Date();
  const fetchMode = (config.fetchMode || "active_today").trim();
  const window =
    fetchMode === "planned_today_tomorrow"
      ? getPlannedWindowTodayTomorrowUtc(now)
      : fetchMode === "planned_this_and_next_week"
      ? getPlannedWindowThisAndNextWeekUtc(now)
      : getTodayWindowUtc(now);

  const results = [];
  for (const sportKey of sports) {
    const usage = client.getUsage();
    if (usage.callsUsed >= usage.maxCalls) {
      break;
    }

    const games = await fetchSportGames(client, sportKey, config, window);

    for (const game of games) {
      if (!game || !game.game_id || !game.commence_time) {
        continue;
      }

      // The free API does not expose a strict live flag in this endpoint,
      // so active_today means games started today and before now.
      const commence = new Date(game.commence_time);
      if (fetchMode === "planned_today_tomorrow") {
        if (commence < now || commence > getTomorrowEndUtc(now)) {
          continue;
        }
      } else if (fetchMode === "planned_this_and_next_week") {
        if (commence < now || commence > getEndOfNextWeekUtc(now)) {
          continue;
        }
      } else if (!isTodayUtc(game.commence_time, now) || commence > now) {
        continue;
      }

      results.push({
        game_id: game.game_id,
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
