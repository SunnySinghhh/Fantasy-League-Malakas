// Season/schedule helpers shared by any page reading data/espn-history.json.
//
// ESPN's schedule mixes playoff and consolation-bracket weeks in with the
// regular season, but record.overall (wins/losses/ties, pointsFor) only
// ever counts regular-season games. Every team plays the same number of
// regular-season games, so the max games any team has recorded is that
// season's regular-season length — this is recomputed from the season's
// own team records (not trusted from any pre-filtered field) so pages stay
// correct even if a data file's own filtering is stale or absent.
function regularSeasonWeeksFor(season) {
  return Math.max.apply(null, season.teams.map(function (t) { return t.wins + t.losses + t.ties; }));
}

function isRegularSeasonWeek(season, week) {
  return week <= regularSeasonWeeksFor(season);
}
