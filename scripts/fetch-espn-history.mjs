// Pulls final standings + weekly scores for every completed past season and
// writes a Hall of Fame summary to data/espn-history.json.
//
// ESPN's historical seasons live at a different endpoint (leagueHistory) than the
// current season, and must be requested one seasonId at a time. We walk backward
// from the current season until we hit a couple of consecutive misses, so this
// doesn't need to know in advance how many past seasons the league has.
//
// Requires env vars: ESPN_S2, ESPN_SWID, LEAGUE_ID, SEASON (current season — the
// walk starts at SEASON - 1). Run by .github/workflows/espn-sync.yml.

import { writeFile } from "node:fs/promises";

const rawEnv = process.env;

for (const [key, value] of Object.entries({
  ESPN_S2: rawEnv.ESPN_S2,
  ESPN_SWID: rawEnv.ESPN_SWID,
  LEAGUE_ID: rawEnv.LEAGUE_ID,
  SEASON: rawEnv.SEASON,
})) {
  if (!value) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const LEAGUE_ID = rawEnv.LEAGUE_ID.trim();
const CURRENT_SEASON = Number(rawEnv.SEASON.trim());
const ESPN_S2 = rawEnv.ESPN_S2.trim();
const ESPN_SWID = rawEnv.ESPN_SWID.trim().replace(/^\{?/, "{").replace(/\}?$/, "}");

const MAX_CONSECUTIVE_MISSES = 2;
const OLDEST_SEASON_TO_TRY = CURRENT_SEASON - 15;

function historyUrl(seasonId) {
  return (
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${LEAGUE_ID}` +
    `?seasonId=${seasonId}&view=mTeam&view=mStandings&view=mMatchupScore`
  );
}

async function fetchSeason(seasonId) {
  const res = await fetch(historyUrl(seasonId), {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Origin: "https://fantasy.espn.com",
      Referer: "https://fantasy.espn.com/",
      "x-fantasy-platform": "espn-fantasy-web",
      "x-fantasy-source": "kona",
      Cookie: `espn_s2=${ESPN_S2}; SWID=${ESPN_SWID}`,
    },
  });

  const bodyText = await res.text();

  if (res.status === 404) {
    console.log(`Season ${seasonId}: 404 — league didn't exist yet, or history isn't available.`);
    return null;
  }
  if (!res.ok) {
    console.log(`Season ${seasonId}: ${res.status} ${res.statusText} — skipping.`);
    return null;
  }
  if (!bodyText) {
    console.log(`Season ${seasonId}: empty body — skipping.`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    console.log(`Season ${seasonId}: non-JSON response — skipping.`);
    return null;
  }

  const league = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!league || !Array.isArray(league.teams) || !league.teams.length) {
    console.log(`Season ${seasonId}: no teams in response — skipping.`);
    return null;
  }

  return league;
}

function teamName(team) {
  if (team.name) return team.name;
  return [team.location, team.nickname].filter(Boolean).join(" ").trim() || `Team ${team.id}`;
}

function round1(n) {
  return typeof n === "number" ? Math.round(n * 10) / 10 : 0;
}

function summarizeSeason(seasonId, league) {
  const overall = (team) => team.record?.overall || {};

  const teams = league.teams.map((team) => ({
    teamId: team.id,
    name: teamName(team),
    wins: overall(team).wins || 0,
    losses: overall(team).losses || 0,
    ties: overall(team).ties || 0,
    pointsFor: round1(overall(team).pointsFor),
    pointsAgainst: round1(overall(team).pointsAgainst),
    finalRank: team.rankCalculatedFinal || 0,
  }));

  const played = teams.some((t) => t.wins + t.losses + t.ties > 0);
  if (!played) {
    console.log(`Season ${seasonId}: no games played — skipping (in-progress season).`);
    return null;
  }

  const hasFinalRank = teams.some((t) => t.finalRank > 0);
  const ranked = hasFinalRank
    ? [...teams].sort((a, b) => a.finalRank - b.finalRank)
    : [...teams].sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);

  const champion = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  const lastPlace = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  const pointsLeader = [...teams].sort((a, b) => b.pointsFor - a.pointsFor)[0] || null;

  const nameById = new Map(teams.map((t) => [t.teamId, t.name]));
  let weekHigh = null;
  // Every matchup is included here — regular season AND playoffs/consolation.
  // `record.overall` (wins/losses/ties, pointsFor) only ever counts regular-
  // season games, so anything consuming this array for head-to-head or
  // season records needs to filter by week using regularSeasonWeeksFor()
  // (assets/season-utils.js) when it wants regular-season-only or
  // playoff-only results.
  const matchups = [];
  for (const matchup of league.schedule || []) {
    const home = matchup.home;
    const away = matchup.away;
    if (home && away && typeof home.totalPoints === "number" && typeof away.totalPoints === "number") {
      matchups.push({
        week: matchup.matchupPeriodId,
        homeTeamId: home.teamId,
        homeScore: round1(home.totalPoints),
        awayTeamId: away.teamId,
        awayScore: round1(away.totalPoints),
        winner: matchup.winner || "UNDECIDED",
      });
    }
    for (const side of [home, away]) {
      if (!side || typeof side.totalPoints !== "number") continue;
      if (!weekHigh || side.totalPoints > weekHigh.points) {
        weekHigh = {
          name: nameById.get(side.teamId) || `Team ${side.teamId}`,
          points: round1(side.totalPoints),
          week: matchup.matchupPeriodId,
        };
      }
    }
  }

  return {
    season: seasonId,
    teams,
    matchups,
    champion: champion && {
      name: champion.name,
      wins: champion.wins,
      losses: champion.losses,
      ties: champion.ties,
      pointsFor: champion.pointsFor,
    },
    runnerUp: runnerUp && { name: runnerUp.name, wins: runnerUp.wins, losses: runnerUp.losses, ties: runnerUp.ties },
    lastPlace: lastPlace && { name: lastPlace.name, wins: lastPlace.wins, losses: lastPlace.losses, ties: lastPlace.ties },
    pointsLeader: pointsLeader && { name: pointsLeader.name, pointsFor: pointsLeader.pointsFor },
    weekHigh,
  };
}

async function main() {
  const seasons = [];
  let misses = 0;

  for (let seasonId = CURRENT_SEASON - 1; seasonId >= OLDEST_SEASON_TO_TRY; seasonId--) {
    const league = await fetchSeason(seasonId);
    const summary = league ? summarizeSeason(seasonId, league) : null;

    if (summary) {
      seasons.push(summary);
      misses = 0;
      continue;
    }

    misses++;
    if (misses >= MAX_CONSECUTIVE_MISSES) {
      console.log(`Hit ${MAX_CONSECUTIVE_MISSES} consecutive missing seasons — stopping at ${seasonId}.`);
      break;
    }
  }

  seasons.sort((a, b) => b.season - a.season);

  let allTimePointsRecord = null;
  let allTimeWeekHigh = null;
  for (const s of seasons) {
    if (s.pointsLeader && (!allTimePointsRecord || s.pointsLeader.pointsFor > allTimePointsRecord.pointsFor)) {
      allTimePointsRecord = { ...s.pointsLeader, season: s.season };
    }
    if (s.weekHigh && (!allTimeWeekHigh || s.weekHigh.points > allTimeWeekHigh.points)) {
      allTimeWeekHigh = { ...s.weekHigh, season: s.season };
    }
  }

  await writeFile(
    new URL("../data/espn-history.json", import.meta.url),
    JSON.stringify(
      {
        lastUpdated: new Date().toISOString(),
        leagueId: LEAGUE_ID,
        seasons,
        records: { points: allTimePointsRecord, weekHigh: allTimeWeekHigh },
      },
      null,
      2
    ) + "\n"
  );

  console.log(`Synced ${seasons.length} past season(s): ${seasons.map((s) => s.season).join(", ") || "none"}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
