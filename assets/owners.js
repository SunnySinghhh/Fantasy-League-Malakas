// Owner identity — shared by any page that needs to attribute stats to the
// actual PERSON behind a team, not just the ESPN roster slot. Several slots
// have changed hands over the years (a different real person took over the
// same roster slot), and a couple of owners have even switched slots season
// to season. This table (confirmed with the commissioner, not inferred from
// name changes) maps every historical (teamId, season) to the owner who
// actually ran it that year. Any (teamId, season) not listed here falls back
// to "one continuous owner for that slot," which covers every team that's
// never changed hands.
//
// activeTeamId: set if this owner currently holds a slot (their name/logo
// comes from live standings); omit/null if they've since left the league
// (their name/logo comes from `name` below instead).
var OWNER_OVERRIDES = [
  { id: "sunny", name: "Sunny's Sp*rm Bank", activeTeamId: 1,
    grants: [{ teamId: 1, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "jpops-owner", name: "JPOPS", activeTeamId: 2,
    grants: [{ teamId: 2, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "manpreet", name: "Manpreet", activeTeamId: null,
    grants: [{ teamId: 5, seasons: [2022] }] },
  { id: "kosta", name: "Kostas", activeTeamId: null,
    // Kosta ran team 12's slot in 2022, then moved to team 5's slot in 2023.
    grants: [{ teamId: 12, seasons: [2022] }, { teamId: 5, seasons: [2023] }] },
  { id: "evan", name: "Ecuador roof repair", activeTeamId: 5,
    grants: [{ teamId: 5, seasons: [2024, 2025] }] },
  { id: "chris", name: "Houston Hicks", activeTeamId: 6,
    // Chris owned this slot in 2022, Alex took it over for two years, then Chris returned in 2025.
    grants: [{ teamId: 6, seasons: [2022, 2025] }] },
  { id: "alex", name: "CP Central", activeTeamId: null,
    grants: [{ teamId: 6, seasons: [2023, 2024] }] },
  { id: "pandelidis-owner", name: "Pandelidis FC", activeTeamId: 8,
    grants: [{ teamId: 8, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "chase-brown-kids-owner", name: "Chase Brown Kids", activeTeamId: 11,
    grants: [{ teamId: 11, seasons: [2022, 2023, 2024, 2025] }] },
  { id: "nick", name: "Purple P()ssy Eaters", activeTeamId: null,
    grants: [{ teamId: 12, seasons: [2023, 2024] }] },
  { id: "dimitri", name: "DeeGotti's Welfare Warriors", activeTeamId: 12,
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

// Builds ownerId -> { id, name, logo, formerNames } from live standings +
// full season history, so any page can look up an owner's canonical
// display name/logo (their current team if still in the league, or their
// OWNER_OVERRIDES reference name/logo if departed) plus every raw ESPN
// name that slot used during seasons this owner actually held.
function buildRegistry(standings, history, ownerIndex) {
  var registry = new Map();
  var standingsById = new Map((standings && standings.teams || []).map(function (t) { return [t.teamId, t]; }));

  // Default identity for every teamId — covers any slot untouched by
  // OWNER_OVERRIDES, and any (teamId, season) an override doesn't claim.
  standingsById.forEach(function (t, teamId) {
    registry.set("team-" + teamId, { id: "team-" + teamId, name: t.name, logo: t.logo || "" });
  });

  // Explicit owner identities.
  OWNER_OVERRIDES.forEach(function (o) {
    var cur = o.activeTeamId ? standingsById.get(o.activeTeamId) : null;
    registry.set(o.id, {
      id: o.id,
      name: cur ? cur.name : o.name,
      logo: cur ? (cur.logo || "") : ""
    });
  });

  var seasonsAsc = (history.seasons || []).slice().sort(function (a, b) { return a.season - b.season; });
  var nameHistory = new Map(); // ownerId -> raw ESPN names used during that owner's seasons
  seasonsAsc.forEach(function (s) {
    (s.teams || []).forEach(function (t) {
      var ownerId = ownerIdFor(ownerIndex, t.teamId, s.season);
      if (!registry.has(ownerId)) {
        registry.set(ownerId, { id: ownerId, name: t.name, logo: "" });
      }
      var arr = nameHistory.get(ownerId) || [];
      arr.push(t.name);
      nameHistory.set(ownerId, arr);
    });
  });

  registry.forEach(function (owner) {
    var seen = new Set([owner.name]);
    var former = [];
    (nameHistory.get(owner.id) || []).forEach(function (n) {
      if (!seen.has(n)) { seen.add(n); former.push(n); }
    });
    owner.formerNames = former;
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
