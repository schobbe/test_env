# test_env

Welcome
This is a simple rep. to test some things

## What's inside

| Page | Description |
| --- | --- |
| `index.html` | Landing page with the counter demo and links to the projects |
| `map.html` | **World Explorer** — zoomable interactive world map with real-time weather (Open-Meteo), a live rain radar overlay (RainViewer) and a portal-independent dark dashboard sidebar |
| `bf6.html` | **BF6 Player Stats** — look up any Battlefield 6 player by name and platform |
| `Hello_World.py` | First Python script in this repo |

### BF6 Player Stats (`bf6.html`)

A single-page dashboard for Battlefield 6 stats, built on the community-run
[gametools.network](https://api.gametools.network/docs) API.

* No API key, no login, no build step and no third-party JavaScript.
* Shows K/D, accuracy, headshot rate, kills, damage, score, playtime plus
  weapons (sortable table), weapon groups, classes, game modes, maps,
  vehicles/archetypes, gadgets, melee and career/objective totals.
* Live panels that are independent of the lookup: an hourly BF6 activity chart
  (`/bf6/statusarray/`).
* Nine diagrams drawn as inline SVG/CSS (no chart library): a normalised
  performance radar, XP composition and kill-type donuts, time per class,
  time per mode, kills per weapon class, a per-mode comparison, a weapon
  scatter of kills vs accuracy and the damage/assist breakdown.
* **Player Highlights** from `/bf6/profile/` — rank, record, dog tags, longest
  kill, best killstreak, ranked/competitive ranks and top badges.
* **My Tracked Progress** — a snapshot trend (K/D, accuracy, win rate, kills/min)
  recorded in this browser's `localStorage`. This is deliberately *not* sold as
  historical data: it starts with your first visit and nothing before that can
  be reconstructed, so the panel says so up front.
* **Session History** — best-effort round-by-round table from
  `/manager/sessions/`, shown only when the endpoint actually returns rows.
* **Saved shortcuts** — the Save button next to the search stores the typed
  name/platform (up to 12) without needing a successful lookup. They render as
  a chip row above Recent: click one to jump back, `×` to forget. Stored in
  `localStorage`, so like the trend data they are browser-local.
* Shareable URLs, e.g. `bf6.html?name=offroad89&platform=steam`.
* **No game artwork is used.** All visuals are CSS-drawn or inline SVG, and no
  images are requested from any asset CDN. Statistics are © EA / DICE.

#### API notes worth knowing

* Only `GET` is usable from a browser — CORS preflight for the batch endpoint
  `/bf6/multiple/` replies `access-control-allow-methods: GET`.
* `/bf6/stats/` returns `200` for `?name=` but `500` for `?playerid=<personaId>`,
  so lookups always go through the player name.
* The OpenAPI example payload for `/bf6/stats/` is stale Battlefield 2042 data
  (PP-29, "Mackay"), so the real response shape was mapped empirically.
* Player names are matched **exactly** — there is no fuzzy search endpoint.
* `/bf6/profile/` is the only endpoint carrying career "records" (rank, badges,
  competitive ranks, `tp_kit_*`/`tp_gm_*` time and `kills_*_total` weapon-class
  kills). Its `stats` array holds ~339 duplicated names of which only ~204 are
  non-null, so the normaliser keeps the first non-null value per name and every
  diagram degrades to an empty state when a field is missing.
* There is **no** match history or time series for ordinary players:
  `/bf6/history/` and `/bf6/battlelog/` are `404`, `perSeason` comes back as an
  empty object, and `/manager/sessions/` answers `{"data":[]}` for almost every
  account — it only knows rounds played on gametools-managed community servers
  and only accepts the legacy platforms `pc` / `ps4` / `xboxone`. That is why
  the session panel hides itself instead of showing an error.

