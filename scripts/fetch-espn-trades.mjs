// Pulls every completed trade across league history (2022 through the
// current season) and writes them to data/espn-trades.json.
//
// UNVERIFIED SHAPE WARNING: ESPN's mTransactions2 view is undocumented and
// this script's parsing was written from third-party reverse-engineering
// (the cwendt94/espn-api Python library's source, plus a maintainer
// discussion noting that a TRADE_ACCEPT transaction's player-level detail
// is a known pain point) — not from an actual ESPN payload, since fetching
// one requires the league's own auth cookies, which aren't available
// outside GitHub Actions. Until a live run confirms the shape, this script:
//   1. Tries several plausible field-name variants when figuring out which
//      team gained/lost each player in a trade (see resolveSides()).
//   2. Writes any transaction it couldn't confidently parse into
//      `unresolved` (with the raw record attached) instead of guessing.
//   3. Always writes data/espn-trades-raw-sample.json — the first few raw
//      TRADE_ACCEPT records untouched — so a real payload can be inspected
//      and this file fixed if `unresolved` turns out non-empty.
//
// Requires env vars: ESPN_S2, ESPN_SWID, LEAGUE_ID, SEASON (current season —
// every season from 2022 up to and including this one is fetched).
// Run by .github/workflows/espn-sync.yml.

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
const OLDEST_SEASON = 2022; // the league's first synced season (see fetch-espn-history.mjs)
const ESPN_S2 = rawEnv.ESPN_S2.trim();
const ESPN_SWID = rawEnv.ESPN_SWID.trim().replace(/^\{?/, "{").replace(/\}?$/, "}");

const BASE_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Origin: "https://fantasy.espn.com",
  Referer: "https://fantasy.espn.com/",
  "x-fantasy-platform": "espn-fantasy-web",
  "x-fantasy-source": "kona",
  Cookie: `espn_s2=${ESPN_S2}; SWID=${ESPN_SWID}`,
};

function leagueUrl(season, extraParams) {
  return (
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${LEAGUE_ID}` +
    `?${extraParams}`
  );
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers: { ...BASE_HEADERS, ...headers } });
  if (!res.ok) {
    console.log(`  ${url} → ${res.status} ${res.statusText}`);
    return null;
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    console.log(`  ${url} → non-JSON response`);
    return null;
  }
}

// A trade's completed state — see the module comment re: the other
// trade-workflow types (PROPOSAL/VETO/DECLINE/UPHOLD/ERROR) that this
// deliberately excludes.
const TRADE_TYPE = "TRADE_ACCEPT";

async function fetchSeasonTransactions(season) {
  const filter = JSON.stringify({ transactions: { filterType: { value: [TRADE_TYPE] } } });
  const data = await getJson(leagueUrl(season, "view=mTransactions2"), { "x-fantasy-filter": filter });
  const all = (data && data.transactions) || [];
  const trades = all.filter((t) => t.type === TRADE_TYPE);
  console.log(`Season ${season}: ${all.length} transaction(s) returned, ${trades.length} trade(s).`);
  return trades;
}

// Builds a season's playerId → name map from ESPN's season-scoped (not
// league-scoped) player list, so a trade involving a player no longer on
// any current roster still resolves to a real name.
async function fetchPlayerMap(season) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?view=players_wl`;
  const data = await getJson(url, { "x-fantasy-filter": JSON.stringify({ players: { limit: 4000 } }) });
  const map = new Map();
  if (Array.isArray(data)) {
    for (const p of data) {
      if (p && p.id != null && p.fullName) map.set(p.id, p.fullName);
    }
  }
  console.log(`Season ${season}: resolved ${map.size} player name(s).`);
  return map;
}

// A trade's `items` array is the part whose shape is unconfirmed (see
// module comment). This tries every field-name variant a trade item might
// plausibly use to say "player X moved from team A to team B", and falls
// back to null (caller records the transaction as unresolved) rather than
// guessing wrong.
function resolveSides(transaction) {
  const items = transaction.items || [];
  const sidesByTeam = new Map(); // teamId -> { in: [], out: [] }

  function side(teamId) {
    if (!sidesByTeam.has(teamId)) sidesByTeam.set(teamId, { teamId, playersIn: [], playersOut: [] });
    return sidesByTeam.get(teamId);
  }

  let allResolved = items.length > 0;

  for (const item of items) {
    const playerId = item.playerId;
    const fromTeamId = item.fromTeamId ?? item.sourceTeamId ?? (item.type === "DROP" ? item.teamId ?? transaction.teamId : undefined);
    const toTeamId = item.toTeamId ?? item.destinationTeamId ?? (item.type === "ADD" ? item.teamId ?? transaction.teamId : undefined);

    if (playerId == null || fromTeamId == null || toTeamId == null) {
      allResolved = false;
      continue;
    }
    side(toTeamId).playersIn.push(playerId);
    side(fromTeamId).playersOut.push(playerId);
  }

  if (!allResolved || sidesByTeam.size < 2) return null;
  return Array.from(sidesByTeam.values());
}

function namePlayers(ids, playerMap) {
  return ids.map((id) => ({ id, name: playerMap.get(id) || `Player ${id}` }));
}

async function buildSeasonTrades(season) {
  const [transactions, playerMap] = await Promise.all([fetchSeasonTransactions(season), fetchPlayerMap(season)]);

  const trades = [];
  const unresolved = [];
  const rawSamples = [];

  for (const t of transactions) {
    if (rawSamples.length < 3) rawSamples.push(t);

    const sides = resolveSides(t);
    if (!sides) {
      unresolved.push({ season, id: t.id ?? null, raw: t });
      continue;
    }

    trades.push({
      season,
      id: t.id ?? null,
      date: t.processDate ?? t.proposedDate ?? null,
      week: t.scoringPeriodId ?? null,
      sides: sides.map((s) => ({
        teamId: s.teamId,
        playersIn: namePlayers(s.playersIn, playerMap),
        playersOut: namePlayers(s.playersOut, playerMap),
      })),
    });
  }

  return { trades, unresolved, rawSamples };
}

async function main() {
  const seasons = [];
  for (let s = OLDEST_SEASON; s <= CURRENT_SEASON; s++) seasons.push(s);

  const allTrades = [];
  const allUnresolved = [];
  const allRawSamples = [];

  for (const season of seasons) {
    try {
      const { trades, unresolved, rawSamples } = await buildSeasonTrades(season);
      allTrades.push(...trades);
      allUnresolved.push(...unresolved);
      if (allRawSamples.length < 5) allRawSamples.push(...rawSamples);
    } catch (err) {
      // One season's request failing (network blip, unexpected shape) shouldn't
      // discard every other season's already-fetched trades.
      console.error(`Season ${season}: failed to fetch/parse trades —`, err);
    }
  }

  allTrades.sort((a, b) => (b.date || 0) - (a.date || 0));

  await writeFile(
    new URL("../data/espn-trades.json", import.meta.url),
    JSON.stringify(
      {
        lastUpdated: new Date().toISOString(),
        leagueId: LEAGUE_ID,
        trades: allTrades,
        // Non-empty means resolveSides() couldn't confidently parse some
        // trades this run — inspect espn-trades-raw-sample.json and fix
        // resolveSides() in scripts/fetch-espn-trades.mjs.
        unresolvedCount: allUnresolved.length,
      },
      null,
      2
    ) + "\n"
  );

  // Always written (even if empty) so it's easy to check whether this ever
  // saw a real trade at all vs. the league just having none yet.
  await writeFile(
    new URL("../data/espn-trades-raw-sample.json", import.meta.url),
    JSON.stringify({ lastUpdated: new Date().toISOString(), samples: allRawSamples, unresolved: allUnresolved.slice(0, 5) }, null, 2) + "\n"
  );

  console.log(`Synced ${allTrades.length} trade(s) across ${seasons.length} season(s), ${allUnresolved.length} unresolved.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
