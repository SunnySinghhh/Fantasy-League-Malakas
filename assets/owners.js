// Owner identity — shared by any page that needs to attribute a team to the
// actual PERSON behind it, not just the ESPN roster slot. Several slots
// have changed hands over the years (a different real person took over the
// same roster slot), and a couple of owners have even switched slots season
// to season. This table (confirmed with the commissioner, not inferred from
// name changes) maps every historical (teamId, season) to the owner who
// actually ran it that year. Any (teamId, season) not listed here falls back
// to "one continuous owner for that slot," which covers every team that's
// never changed hands.
//
// `name` is always the sanitized display name (first name only, or a
// handle) shown across the whole site — deliberately never the raw ESPN
// team name, which can be crude. This is a display-layer swap only: the
// actual ESPN league and its team names are untouched.
//
// activeTeamId: set if this owner currently holds a slot (their logo comes
// from live standings); omit/null if they've since left the league (no
// logo, just the name).
var OWNER_OVERRIDES = [
  { id: "sunny", name: "Sunny", activeTeamId: 1,
    grants: [{ teamId: 1, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "jpops-owner", name: "Jake", activeTeamId: 2,
    grants: [{ teamId: 2, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "team-3", name: "Nav", activeTeamId: 3,
    grants: [{ teamId: 3, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "team-4", name: "Michael N", activeTeamId: 4,
    grants: [{ teamId: 4, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "manpreet", name: "Manpreet", activeTeamId: null,
    grants: [{ teamId: 5, seasons: [2022] }] },
  { id: "kosta", name: "Kostas", activeTeamId: null,
    // Kosta ran team 12's slot in 2022, then moved to team 5's slot in 2023.
    grants: [{ teamId: 12, seasons: [2022] }, { teamId: 5, seasons: [2023] }] },
  { id: "evan", name: "Evan", activeTeamId: 5,
    grants: [{ teamId: 5, seasons: [2024, 2025] }] },
  { id: "chris", name: "Chris", activeTeamId: 6,
    // Chris owned this slot in 2022, then Alex ran it through 2025 — Chris
    // returned for the 2026 season (activeTeamId above covers that; no
    // grant needed since grants only list already-completed seasons).
    grants: [{ teamId: 6, seasons: [2022] }] },
  { id: "alex", name: "Alex", activeTeamId: null,
    grants: [{ teamId: 6, seasons: [2023, 2024, 2025] }] },
  { id: "team-7", name: "Peter", activeTeamId: 7,
    grants: [{ teamId: 7, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "pandelidis-owner", name: "Stas", activeTeamId: 8,
    grants: [{ teamId: 8, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "team-9", name: "George K", activeTeamId: 9,
    grants: [{ teamId: 9, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "team-10", name: "Cejpek", activeTeamId: 10,
    grants: [{ teamId: 10, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "chase-brown-kids-owner", name: "Rohan", activeTeamId: 11,
    grants: [{ teamId: 11, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "nick", name: "Nick", activeTeamId: null,
    grants: [{ teamId: 12, seasons: [2023, 2024] }] },
  { id: "dimitri", name: "Dimitri", activeTeamId: 12,
    grants: [{ teamId: 12, seasons: [2025] }] }
];

function buildOwnerIndex() {
  var map = new Map(); // "teamId:season" -> ownerId
  OWNER_OVERRIDES.forEach(function (o) {
    o.grants.forEach(function (g) {
      g.seasons.forEach(function (season) {
        map.set(g.teamId + ":" + season, o.id);
      });
    });
  });
  return map;
}

// Any (teamId, season) not covered by an override is one continuous
// owner for that slot — the common case.
function ownerIdFor(ownerIndex, teamId, season) {
  var key = teamId + ":" + season;
  return ownerIndex.has(key) ? ownerIndex.get(key) : "team-" + teamId;
}

// Who currently holds a slot, for a season not yet covered by any grant
// (e.g. the upcoming season before it's been played) — an owner's `grants`
// only list seasons already confirmed, so this resolves by `activeTeamId`
// instead of by season lookup.
function currentOwnerIdFor(teamId) {
  var found = OWNER_OVERRIDES.filter(function (o) { return o.activeTeamId === teamId; })[0];
  return found ? found.id : "team-" + teamId;
}

// The sanitized display name for an ownerId — every owner in this league
// has an OWNER_OVERRIDES entry, so this should always resolve; the raw id
// itself is the only fallback, and should never actually surface.
function ownerDisplayName(ownerId) {
  var found = OWNER_OVERRIDES.filter(function (o) { return o.id === ownerId; })[0];
  return found ? found.name : ownerId;
}

// Convenience for pages that don't need the full registry: the sanitized
// name for whoever held `teamId` in `season` (or, with season omitted,
// whoever holds it right now).
function displayNameForTeam(teamId, season) {
  if (season == null) return ownerDisplayName(currentOwnerIdFor(teamId));
  return ownerDisplayName(ownerIdFor(buildOwnerIndex(), teamId, season));
}

// Builds ownerId -> { id, name, logo } from live standings (for the logo
// only — name always comes from OWNER_OVERRIDES, never from ESPN).
function buildRegistry(standings, history, ownerIndex) {
  var registry = new Map();
  var standingsById = new Map((standings && standings.teams || []).map(function (t) { return [t.teamId, t]; }));

  OWNER_OVERRIDES.forEach(function (o) {
    var cur = o.activeTeamId ? standingsById.get(o.activeTeamId) : null;
    registry.set(o.id, {
      id: o.id,
      name: o.name,
      logo: cur ? (cur.logo || "") : ""
    });
  });

  // Any (teamId, season) an override doesn't explicitly claim still needs an
  // entry — shouldn't happen now that every current team has an override,
  // but stay defensive for a slot this table hasn't caught up to yet.
  (history.seasons || []).forEach(function (s) {
    (s.teams || []).forEach(function (t) {
      var ownerId = ownerIdFor(ownerIndex, t.teamId, s.season);
      if (!registry.has(ownerId)) {
        registry.set(ownerId, { id: ownerId, name: ownerDisplayName(ownerId), logo: "" });
      }
    });
  });

  return registry;
}

function fallbackLogoHtml(name) {
  return '<span class="fallback-logo">' + (name ? name.charAt(0) : "?") + '</span>';
}

function teamLogoHtml(team) {
  return team.logo
    ? '<img src="' + team.logo + '" alt="" loading="lazy">'
    : fallbackLogoHtml(team.name);
}
