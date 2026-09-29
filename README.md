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
  (`/bf6/statusarray/`) and a portal server browser (`/bf6/servers/`).
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

