// BACKLOG STATUS: this script still runs in the sync workflow (cheap, and
// keeps quietly gathering real data), but there is currently no trades.html
// page consuming data/espn-trades.json — it was pulled from the live site
// because the parsing below has never been verified against a real ESPN
// payload (see warning below), only against mocked responses. Before
// re-adding a trade log page: check data/espn-trades-raw-sample.json's
// `diagnostics` for real totalCount/typeCounts per season, confirm
// `unresolvedCount` in espn-trades.json is 0, and spot-check that a real
// trade's `sides` look right, THEN reintroduce the page (trades.html was
// removed via git — see repo history around this comment being added).
//
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
// It's also unconfirmed whether mTransactions2 returns a whole season with
// no scoringPeriodId or needs one per week — a whole-season request that
// comes back completely empty is retried as a per-week loop (1..MAX_WEEK)
// before concluding the season really has none. A past season's trades
// can't change once settled (see `settledSeasons` in the output and its
// use in main()), so that expensive loop only runs once per season ever,
// not on every 30-minute sync — only the current season always re-fetches.
//
// Requires env vars: ESPN_S2, ESPN_SWID, LEAGUE_ID, SEASON (current season —
// every season from 2022 up to and including this one is fetched).
// Run by .github/workflows/espn-sync.yml.

import { writeFile, readFile } from "node:fs/promises";

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

// Returns { trades, diagnostic }. diagnostic distinguishes "the request
// worked and this league truly has zero matching transactions" from "the
// request itself is silently failing" — both look identical from the
// outside otherwise, and this view is unverified/undocumented enough that
// telling them apart matters. requestFailed means getJson() got no body at
// all (network/auth/4xx); totalCount is EVERY transaction type returned
// (waivers, adds, drops, trades) — a real league with any activity across a
// full season should show a nonzero totalCount even in seasons with no
// trades, so a 0 there across every season is the tell that something
// upstream of type-filtering is wrong, not that the league is trade-free.
const MAX_WEEK = 17; // regular season + playoffs/consolation, matches fetch-espn-history.mjs's observed range

async function fetchTransactionsFor(season, scoringPeriodId) {
  const filter = JSON.stringify({ transactions: { filterType: { value: [TRADE_TYPE] } } });
  const params = "view=mTransactions2" + (scoringPeriodId ? `&scoringPeriodId=${scoringPeriodId}` : "");
  const data = await getJson(leagueUrl(season, params), { "x-fantasy-filter": filter });
  return { requestFailed: data == null, all: (data && data.transactions) || [] };
}

async function fetchSeasonTransactions(season) {
  // Try one whole-season request first (cheap, and may well be how this
  // view actually works) — if it comes back completely empty, that's
  // ambiguous (zero trades ever, vs. this view being scoped to a scoring
  // period and returning nothing without one), so fall back to looping
  // every week and aggregating before concluding there's really nothing.
  let { requestFailed, all } = await fetchTransactionsFor(season, null);
  let usedWeekLoop = false;

  if (!requestFailed && all.length === 0) {
    usedWeekLoop = true;
    const seen = new Set();
    for (let week = 1; week <= MAX_WEEK; week++) {
      const weekResult = await fetchTransactionsFor(season, week);
      if (weekResult.requestFailed) continue;
      for (const t of weekResult.all) {
        const key = t.id ?? JSON.stringify(t);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(t);
      }
    }
  }

  const trades = all.filter((t) => t.type === TRADE_TYPE);
  const typeCounts = {};
  for (const t of all) typeCounts[t.type] = (typeCounts[t.type] || 0) + 1;
  console.log(`Season ${season}: ${all.length} transaction(s) returned${usedWeekLoop ? " (via per-week loop)" : ""}, ${trades.length} trade(s). Types: ${JSON.stringify(typeCounts)}`);
  return { trades, diagnostic: { season, requestFailed, usedWeekLoop, totalCount: all.length, typeCounts } };
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
  const [{ trades: transactions, diagnostic }, playerMap] = await Promise.all([
    fetchSeasonTransactions(season),
    fetchPlayerMap(season),
  ]);

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

  return { trades, unresolved, rawSamples, diagnostic };
}

async function loadPrior() {
  try {
    return JSON.parse(await readFile(new URL("../data/espn-trades.json", import.meta.url), "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const seasons = [];
  for (let s = OLDEST_SEASON; s <= CURRENT_SEASON; s++) seasons.push(s);

  const prior = await loadPrior();
  const priorSettled = new Set((prior && prior.settledSeasons) || []);
  const priorTradesBySeason = new Map();
  if (prior && Array.isArray(prior.trades)) {
    for (const t of prior.trades) {
      if (!priorTradesBySeason.has(t.season)) priorTradesBySeason.set(t.season, []);
      priorTradesBySeason.get(t.season).push(t);
    }
  }

  const allTrades = [];
  const allUnresolved = [];
  const allRawSamples = [];
  const diagnostics = [];
  const settledSeasons = [];

  for (const season of seasons) {
    // A past season's trade history can't change. Once a run gets a real
    // (non-failed) answer for it — trades found, or confirmed via the
    // per-week loop that there are none — there's no need to keep paying
    // for a 17-request-per-season loop on every 30-minute sync forever.
    // The current season always re-fetches, since new trades can happen.
    if (season !== CURRENT_SEASON && priorSettled.has(season)) {
      allTrades.push(...(priorTradesBySeason.get(season) || []));
      settledSeasons.push(season);
      console.log(`Season ${season}: already settled from a prior run, reusing ${priorTradesBySeason.get(season)?.length || 0} trade(s).`);
      continue;
    }

    try {
      const { trades, unresolved, rawSamples, diagnostic } = await buildSeasonTrades(season);
      allTrades.push(...trades);
      allUnresolved.push(...unresolved);
      if (allRawSamples.length < 5) allRawSamples.push(...rawSamples);
      diagnostics.push(diagnostic);
      if (season !== CURRENT_SEASON && !diagnostic.requestFailed) settledSeasons.push(season);
    } catch (err) {
      // One season's request failing (network blip, unexpected shape) shouldn't
      // discard every other season's already-fetched trades.
      console.error(`Season ${season}: failed to fetch/parse trades —`, err);
      diagnostics.push({ season, requestFailed: true, error: String(err) });
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
        // Past seasons in this list are skipped on future runs (see main())
        // rather than re-fetched every 30 minutes — the current season is
        // deliberately never added here since it's still live.
        settledSeasons: settledSeasons,
      },
      null,
      2
    ) + "\n"
  );

  // Always written (even if empty) so it's easy to check whether this ever
  // saw a real trade at all vs. the league just having none yet.
  await writeFile(
    new URL("../data/espn-trades-raw-sample.json", import.meta.url),
    JSON.stringify(
      {
        lastUpdated: new Date().toISOString(),
        // Per-season diagnostic: if totalCount is 0 for every season here,
        // the request itself is silently failing (a real season always has
        // SOME waiver/add/drop activity) — not that the league has no
        // trades. requestFailed:true means getJson() got no response body
        // at all (network/auth/4xx).
        diagnostics,
        samples: allRawSamples,
        unresolved: allUnresolved.slice(0, 5),
      },
      null,
      2
    ) + "\n"
  );

  console.log(`Synced ${allTrades.length} trade(s) across ${seasons.length} season(s), ${allUnresolved.length} unresolved.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
