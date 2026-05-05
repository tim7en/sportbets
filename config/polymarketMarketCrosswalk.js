module.exports = {
  comparableMarkets: [
    {
      type: "match_winner",
      bookmakerMarketKey: "h2h",
      comparisonStrategy: "named_sides",
      enabled: true,
    },
    {
      type: "yes_no_team_win",
      bookmakerMarketKey: "h2h",
      comparisonStrategy: "yes_no_question",
      requireQuestionDateMatch: true,
      enabled: true,
    },
    {
      type: "total_over_under",
      bookmakerMarketKey: "totals",
      comparisonStrategy: "over_under_line",
      requireLineMatch: true,
      enabled: true,
    },
    {
      type: "spread",
      bookmakerMarketKey: "spreads",
      comparisonStrategy: "named_sides_line",
      requireLineMatch: true,
      enabled: true,
    },

    // Leave these disabled until bookmaker-side equivalents are ingested.
    { type: "game_winner", enabled: false },
    { type: "map_winner", enabled: false },
    { type: "set_winner", enabled: false },
    { type: "match_total_over_under", enabled: false },
    { type: "match_total_sets", enabled: false },
    { type: "set_games_over_under", enabled: false },
    { type: "set_handicap", enabled: false },
    { type: "submatch_handicap", enabled: false },
    { type: "both_teams_prop", enabled: false },
    { type: "player_achievement", enabled: false },
    { type: "kills_total_over_under", enabled: false },
    { type: "spread", enabled: false },
  ],
};