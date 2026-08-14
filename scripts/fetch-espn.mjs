// Pulls standings + current-week scoreboard from ESPN's private fantasy API
// and writes them to data/espn-standings.json and data/espn-scoreboard.json.
//
// Requires env vars: ESPN_S2, ESPN_SWID, LEAGUE_ID, SEASON
// Run by .github/workflows/espn-sync.yml on a schedule.

import { writeFile } from "node:fs/promises";

const { ESPN_S2, ESPN_SWID, LEAGUE_ID, SEASON } = process.env;

for (const [key, value] of Object.entries({ ESPN_S2, ESPN_SWID, LEAGUE_ID, SEASON })) {
  if (!value) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const API_URL =
  `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}` +
  `?view=mTeam&view=mStandings&view=mScoreboard&view=mMatchupScore&view=mSettings`;

async function fetchLeague() {
  const res = await fetch(API_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; league-site-sync/1.0)",
      Cookie: `espn_s2=${ESPN_S2}; SWID=${ESPN_SWID}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ESPN API request failed: ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
  }

  return res.json();
}

function teamName(team) {
  if (team.name) return team.name;
  return [team.location, team.nickname].filter(Boolean).join(" ").trim() || `Team ${team.id}`;
}

function buildStandings(league) {
  const teams = (league.teams || []).map((team) => {
    const record = team.record?.overall || {};
    return {
      teamId: team.id,
      name: teamName(team),
      abbrev: team.abbrev || "",
      logo: team.logo || "",
      wins: record.wins || 0,
      losses: record.losses || 0,
      ties: record.ties || 0,
      pointsFor: round1(record.pointsFor),
      pointsAgainst: round1(record.pointsAgainst),
      streakType: record.streakType || "",
      streakLength: record.streakLength || 0,
    };
  });

  teams.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.ties !== a.ties) return b.ties - a.ties;
    return b.pointsFor - a.pointsFor;
  });

  teams.forEach((team, index) => {
    team.rank = index + 1;
  });

  return teams;
}

function round1(n) {
  return typeof n === "number" ? Math.round(n * 10) / 10 : 0;
}

function buildScoreboard(league, standings) {
  const nameById = new Map(standings.map((t) => [t.teamId, t.name]));
  const currentWeek = league.status?.currentMatchupPeriod || league.scoringPeriodId || 1;

  const matchups = (league.schedule || [])
    .filter((m) => m.matchupPeriodId === currentWeek)
    .map((m) => ({
      home: sideInfo(m.home, nameById),
      away: m.away ? sideInfo(m.away, nameById) : null,
      winner: m.winner || "UNDECIDED",
    }));

  return { week: currentWeek, matchups };
}

function sideInfo(side, nameById) {
  if (!side) return null;
  return {
    teamId: side.teamId,
    name: nameById.get(side.teamId) || `Team ${side.teamId}`,
    score: round1(side.totalPoints),
  };
}

async function main() {
  const league = await fetchLeague();
  const standings = buildStandings(league);
  const scoreboard = buildScoreboard(league, standings);
  const lastUpdated = new Date().toISOString();

  await writeFile(
    new URL("../data/espn-standings.json", import.meta.url),
    JSON.stringify({ lastUpdated, season: Number(SEASON), leagueId: LEAGUE_ID, teams: standings }, null, 2) + "\n"
  );

  await writeFile(
    new URL("../data/espn-scoreboard.json", import.meta.url),
    JSON.stringify({ lastUpdated, ...scoreboard }, null, 2) + "\n"
  );

  console.log(`Synced ${standings.length} teams, week ${scoreboard.week} (${scoreboard.matchups.length} matchups).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
