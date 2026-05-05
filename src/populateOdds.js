function populateOddsSnapshot(db, games) {
  const upsertGame = db.prepare(`
    INSERT INTO games (
      game_id,
      sport_key,
      sport_title,
      commence_time,
      home_team,
      away_team,
      last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET
      sport_key = excluded.sport_key,
      sport_title = excluded.sport_title,
      commence_time = excluded.commence_time,
      home_team = excluded.home_team,
      away_team = excluded.away_team,
      last_seen_at = excluded.last_seen_at
  `);

  const deleteBookmakers = db.prepare(
    "DELETE FROM bookmakers WHERE game_id = ?"
  );
  const deleteOdds = db.prepare("DELETE FROM odds WHERE game_id = ?");

  const insertBookmaker = db.prepare(`
    INSERT OR REPLACE INTO bookmakers (
      game_id,
      bookmaker_key,
      bookmaker_title,
      last_update
    ) VALUES (?, ?, ?, ?)
  `);

  const insertOdd = db.prepare(`
    INSERT OR REPLACE INTO odds (
      game_id,
      bookmaker_key,
      market_key,
      outcome_name,
      price,
      point
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((items) => {
    for (const game of items) {
      upsertGame.run(
        game.game_id,
        game.sport_key,
        game.sport_title,
        game.commence_time,
        game.home_team,
        game.away_team,
        game.last_seen_at
      );

      deleteOdds.run(game.game_id);
      deleteBookmakers.run(game.game_id);

      for (const bookmaker of game.bookmakers || []) {
        insertBookmaker.run(
          game.game_id,
          bookmaker.key,
          bookmaker.title,
          bookmaker.last_update || null
        );

        const markets = Array.isArray(bookmaker.markets) ? bookmaker.markets : [];
        for (const market of markets) {
          const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
          for (const outcome of outcomes) {
            insertOdd.run(
              game.game_id,
              bookmaker.key,
              market.key,
              outcome.name,
              outcome.price ?? null,
              outcome.point ?? null
            );
          }
        }
      }
    }
  });

  tx(games);
  return { gamesUpserted: games.length };
}

module.exports = {
  populateOddsSnapshot,
};
