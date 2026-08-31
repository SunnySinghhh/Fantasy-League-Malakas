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

function fallbackLogoHtml(name) {
  return '<span class="fallback-logo">' + (name ? name.charAt(0) : "?") + '</span>';
}

function teamLogoHtml(team) {
  return team.logo
    ? '<img src="' + team.logo + '" alt="" loading="lazy">'
    : fallbackLogoHtml(team.name);
}
