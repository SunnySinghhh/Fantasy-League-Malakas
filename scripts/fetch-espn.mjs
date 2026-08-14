// Pulls standings + current-week scoreboard from ESPN's private fantasy API
// and writes them to data/espn-standings.json and data/espn-scoreboard.json.
//
// Requires env vars: ESPN_S2, ESPN_SWID, LEAGUE_ID, SEASON
// Run by .github/workflows/espn-sync.yml on a schedule.

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
const SEASON = rawEnv.SEASON.trim();
const ESPN_S2 = rawEnv.ESPN_S2.trim();
// ESPN's SWID cookie is wrapped in curly braces; tolerate the value being pasted with or without them.
const ESPN_SWID = rawEnv.ESPN_SWID.trim().replace(/^\{?/, "{").replace(/\}?$/, "}");

// ESPN's browser app calls this host directly (not fantasy.espn.com/apis/...), and requires
// CORS-style headers (Origin/Referer + x-fantasy-*) or it silently rejects the request.
const API_URL =
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}` +
  `?view=mTeam&view=mRoster&view=mMatchupScore&view=mScoreboard&view=mSettings`;

async function fetchLeague() {
  const res = await fetch(API_URL, {
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
  console.log(
    `ESPN API responded ${res.status} ${res.statusText} (content-type: ${res.headers.get("content-type") || "none"}, body length: ${bodyText.length})`
  );

  if (!res.ok) {
    throw new Error(`ESPN API request failed: ${res.status} ${res.statusText}\n${bodyText.slice(0, 500)}`);
  }

  if (!bodyText) {
    throw new Error(
      "ESPN API returned a 200 OK with an empty body. This almost always means the espn_s2/SWID " +
      "cookies aren't authenticating for this league (expired, mismatched account, or copied incorrectly). " +
      "Re-grab both cookie values from a logged-in browser session and update the ESPN_S2 / ESPN_SWID repo secrets."
    );
  }

  try {
    return JSON.parse(bodyText);
  } catch (err) {
    throw new Error(`ESPN API returned non-JSON content (status ${res.status}):\n${bodyText.slice(0, 500)}`);
  }
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
