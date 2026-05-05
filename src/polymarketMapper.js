require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createDatabase } = require("./db");
const { normalizeTeamName, teamSimilarity, parseMatchTeams } = require("./nameMatch");

function nowIso() {
  return new Date().toISOString();
}

function readJsonOrJsonl(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function canonicalizePolymarketRecord(record) {
  const id = String(
    record.id || record.event_id || record.market_id || record.slug || ""
  ).trim();
  const title = String(
    record.title || record.question || record.market || record.name || ""
  ).trim();

  return {
    polymarket_event_id: id,
    title,
    slug: record.slug ? String(record.slug) : null,
    sport_hint: record.sport || record.category || record.league || null,
    start_time:
      record.start_time || record.startTime || record.event_start_time || null,
    raw_json: JSON.stringify(record),
  };
}

function upsertTeamAlias(db, source, aliasName) {
  const aliasNormalized = normalizeTeamName(aliasName);
  if (!aliasName || !aliasNormalized) {
    return null;
  }

  const existingAlias = db
    .prepare(
      "SELECT team_entity_id FROM team_aliases WHERE source = ? AND alias_normalized = ?"
    )
    .get(source, aliasNormalized);

  if (existingAlias) {
    return existingAlias.team_entity_id;
  }

  const existingEntity = db
    .prepare("SELECT team_entity_id FROM team_entities WHERE normalized_name = ?")
    .get(aliasNormalized);

  const ts = nowIso();
  let teamEntityId;
  if (existingEntity) {
    teamEntityId = existingEntity.team_entity_id;
  } else {
    const result = db
      .prepare(
        `
        INSERT INTO team_entities (canonical_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `
      )
      .run(aliasName, aliasNormalized, ts, ts);
    teamEntityId = result.lastInsertRowid;
  }

  db.prepare(
    `
    INSERT OR IGNORE INTO team_aliases (
      team_entity_id,
      source,
      alias_name,
      alias_normalized,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
  `
  ).run(teamEntityId, source, aliasName, aliasNormalized, ts);

  db.prepare("UPDATE team_entities SET updated_at = ? WHERE team_entity_id = ?").run(
    ts,
    teamEntityId
  );

  return teamEntityId;
}

function indexOddsTeams(db) {
  const rows = db
    .prepare(
      "SELECT DISTINCT home_team, away_team FROM games WHERE home_team IS NOT NULL AND away_team IS NOT NULL"
    )
    .all();

  let aliasCount = 0;
  const tx = db.transaction((items) => {
    for (const row of items) {
      const a = upsertTeamAlias(db, "odds", row.home_team);
      const b = upsertTeamAlias(db, "odds", row.away_team);
      if (a) {
        aliasCount += 1;
      }
      if (b) {
        aliasCount += 1;
      }
    }
  });

  tx(rows);
  return { teamsIndexedFromGames: rows.length, aliasesUpsertAttempted: aliasCount };
}

function importPolymarketEvents(db, filePath) {
  if (!fs.existsSync(filePath)) {
    return { imported: 0, skipped: 0, reason: "file_not_found" };
  }

  const records = readJsonOrJsonl(filePath);
  let imported = 0;
  let skipped = 0;
  const ts = nowIso();

  const tx = db.transaction((items) => {
    for (const record of items) {
      const normalized = canonicalizePolymarketRecord(record);
      if (!normalized.polymarket_event_id || !normalized.title) {
        skipped += 1;
        continue;
      }

      const parsed = parseMatchTeams(normalized.title);
      if (parsed) {
        upsertTeamAlias(db, "polymarket", parsed.left);
        upsertTeamAlias(db, "polymarket", parsed.right);
      }

      db.prepare(
        `
        INSERT INTO polymarket_events (
          polymarket_event_id,
          title,
          slug,
          sport_hint,
          start_time,
          raw_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(polymarket_event_id) DO UPDATE SET
          title = excluded.title,
          slug = excluded.slug,
          sport_hint = excluded.sport_hint,
          start_time = excluded.start_time,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at
      `
      ).run(
        normalized.polymarket_event_id,
        normalized.title,
        normalized.slug,
        normalized.sport_hint,
        normalized.start_time,
        normalized.raw_json,
        ts,
        ts
      );

      imported += 1;
    }
  });

  tx(records);
  return { imported, skipped };
}

function importMappingOverrides(db, filePath) {
  if (!fs.existsSync(filePath)) {
    return { imported: 0, skipped: 0, reason: "file_not_found" };
  }

  const records = readJsonOrJsonl(filePath);
  let imported = 0;
  let skipped = 0;
  const ts = nowIso();

  const tx = db.transaction((items) => {
    for (const record of items) {
      const polymarketEventId = String(record.polymarket_event_id || "").trim();
      const gameId = String(record.game_id || "").trim();
      const note = record.note ? String(record.note) : null;

      if (!polymarketEventId || !gameId) {
        skipped += 1;
        continue;
      }

      db.prepare(
        `
        INSERT INTO mapping_overrides (
          polymarket_event_id,
          game_id,
          note,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(polymarket_event_id) DO UPDATE SET
          game_id = excluded.game_id,
          note = excluded.note,
          updated_at = excluded.updated_at
      `
      ).run(polymarketEventId, gameId, note, ts, ts);

      imported += 1;
    }
  });

  tx(records);
  return { imported, skipped };
}

function scoreCandidate(event, game, parsedTeams, timeWindowHours) {
  let leftRightScore = 0;
  let swappedScore = 0;

  if (parsedTeams) {
    leftRightScore =
      (teamSimilarity(parsedTeams.left, game.home_team) +
        teamSimilarity(parsedTeams.right, game.away_team)) /
      2;
    swappedScore =
      (teamSimilarity(parsedTeams.left, game.away_team) +
        teamSimilarity(parsedTeams.right, game.home_team)) /
      2;
  }

  const nameScore = Math.max(leftRightScore, swappedScore);

  let timeScore = 0.5;
  if (event.start_time) {
    const eventTs = new Date(event.start_time).getTime();
    const gameTs = new Date(game.commence_time).getTime();
    if (Number.isFinite(eventTs) && Number.isFinite(gameTs)) {
      const diffHours = Math.abs(eventTs - gameTs) / (1000 * 60 * 60);
      timeScore = Math.max(0, 1 - diffHours / timeWindowHours);
    }
  }

  let sportScore = 0.5;
  if (event.sport_hint) {
    const hint = normalizeTeamName(event.sport_hint);
    const sport = normalizeTeamName(game.sport_title);
    if (hint && sport) {
      sportScore = sport.includes(hint) || hint.includes(sport) ? 1 : 0.3;
    }
  }

  const confidence = 0.65 * nameScore + 0.25 * timeScore + 0.1 * sportScore;
  return Number(confidence.toFixed(6));
}

function mapPolymarketEventsToOdds(db, options = {}) {
  const timeWindowHours = Number(options.timeWindowHours || 12);
  const autoMatchThreshold = Number(options.autoMatchThreshold || 0.78);
  const pendingThreshold = Number(options.pendingThreshold || 0.58);

  const events = db
    .prepare("SELECT * FROM polymarket_events ORDER BY start_time IS NULL, start_time ASC")
    .all();
  const games = db
    .prepare(
      "SELECT game_id, sport_title, commence_time, home_team, away_team FROM games"
    )
    .all();
  const overrides = new Map(
    db
      .prepare("SELECT polymarket_event_id, game_id, note FROM mapping_overrides")
      .all()
      .map((row) => [row.polymarket_event_id, row])
  );

  const ts = nowIso();
  let matched = 0;
  let pending = 0;
  let ignored = 0;

  const tx = db.transaction(() => {
    for (const event of events) {
      const override = overrides.get(event.polymarket_event_id);
      if (override) {
        db.prepare(
          `
          INSERT INTO event_mappings (
            polymarket_event_id,
            game_id,
            confidence_score,
            status,
            reason,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(polymarket_event_id) DO UPDATE SET
            game_id = excluded.game_id,
            confidence_score = excluded.confidence_score,
            status = excluded.status,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        `
        ).run(
          event.polymarket_event_id,
          override.game_id,
          1,
          "matched_override",
          override.note || "manual_override",
          ts,
          ts
        );
        matched += 1;
        continue;
      }

      const parsed = parseMatchTeams(event.title);
      let best = null;

      for (const game of games) {
        const confidence = scoreCandidate(event, game, parsed, timeWindowHours);
        if (!best || confidence > best.confidence) {
          best = {
            game_id: game.game_id,
            confidence,
            reason: parsed ? "name+time+sport_score" : "time+sport_score",
          };
        }
      }

      if (!best) {
        ignored += 1;
        continue;
      }

      let status = "ignored";
      if (best.confidence >= autoMatchThreshold) {
        status = "matched";
        matched += 1;
      } else if (best.confidence >= pendingThreshold) {
        status = "pending_review";
        pending += 1;
      } else {
        ignored += 1;
      }

      db.prepare(
        `
        INSERT INTO event_mappings (
          polymarket_event_id,
          game_id,
          confidence_score,
          status,
          reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(polymarket_event_id) DO UPDATE SET
          game_id = excluded.game_id,
          confidence_score = excluded.confidence_score,
          status = excluded.status,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `
      ).run(
        event.polymarket_event_id,
        best.game_id,
        best.confidence,
        status,
        best.reason,
        ts,
        ts
      );
    }
  });

  tx();
  return {
    eventsProcessed: events.length,
    matched,
    pending,
    ignored,
    thresholds: {
      autoMatchThreshold,
      pendingThreshold,
      timeWindowHours,
    },
  };
}

function exportMappings(db, outputPath) {
  const rows = db
    .prepare(
      `
      SELECT
        em.polymarket_event_id,
        pe.title AS polymarket_title,
        pe.start_time AS polymarket_start_time,
        g.game_id,
        g.sport_title,
        g.commence_time,
        g.home_team,
        g.away_team,
        em.confidence_score,
        em.status,
        em.reason
      FROM event_mappings em
      JOIN polymarket_events pe ON pe.polymarket_event_id = em.polymarket_event_id
      LEFT JOIN games g ON g.game_id = em.game_id
      ORDER BY em.status DESC, em.confidence_score DESC
    `
    )
    .all();

  fs.writeFileSync(outputPath, rows.map((r) => JSON.stringify(r)).join("\n"));
  return { exportedRows: rows.length, outputPath };
}

function main() {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "sportbets.db");
  const polymarketFile =
    process.env.POLYMARKET_EVENTS_FILE ||
    path.join(process.cwd(), "data", "polymarket_events.jsonl");
  const overridesFile =
    process.env.POLYMARKET_OVERRIDES_FILE ||
    path.join(process.cwd(), "data", "polymarket_overrides.jsonl");

  const db = createDatabase(dbPath);
  try {
    const indexed = indexOddsTeams(db);
    const imported = importPolymarketEvents(db, polymarketFile);
    const overrides = importMappingOverrides(db, overridesFile);
    const mapped = mapPolymarketEventsToOdds(db, {
      timeWindowHours: Number(process.env.MATCH_TIME_WINDOW_HOURS || 12),
      autoMatchThreshold: Number(process.env.MATCH_AUTO_THRESHOLD || 0.78),
      pendingThreshold: Number(process.env.MATCH_PENDING_THRESHOLD || 0.58),
    });

    const outFile = path.join(process.cwd(), "data", "polymarket_event_mappings.jsonl");
    const exported = exportMappings(db, outFile);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          dbPath,
          indexed,
          imported,
          overrides,
          mapped,
          exported,
          polymarketFile,
          overridesFile,
          note:
            imported.reason === "file_not_found"
              ? "Create data/polymarket_events.jsonl (or set POLYMARKET_EVENTS_FILE) to map against real Polymarket events."
              : null,
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
