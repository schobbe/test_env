/* =========================================================================
   BF6 Player Stats
   Client for the community-run gametools.network API.

   Design notes (all verified against the live API):
   - No API key and no auth of any kind.
   - Only GET is allowed cross-origin: the CORS preflight for the batch
     endpoint /bf6/multiple/ answers "access-control-allow-methods: GET",
     so POST is unusable from a browser and is therefore never used here.
   - /bf6/stats/ answers 200 for ?name= but 500 for ?playerid=<personaId>,
     so the player is always resolved first and then queried by name.
   - The OpenAPI example payload for /bf6/stats/ is stale BF2042 data
     (PP-29, "Mackay"), so nothing here is written against that example.
   - No external images: every visual is CSS or inline SVG.
   ========================================================================= */

/* ------------------------------- CONFIG -------------------------------- */

const API_BASE = 'https://api.gametools.network';
const GAME = 'bf6';

const CACHE_TTL_MS = 10 * 60 * 1000;  /* mirrors cache-control: max-age=600 */
const REQUEST_TIMEOUT_MS = 12000;
const THROTTLE_MS = 1000;             /* polite, client-side */
const MAX_RETRIES = 1;                /* one retry for transient 5xx */

/* Item label source.
   'name' -> in-game names (readable, factual identifiers)
   'id'   -> raw internal ids, e.g. wp_mg_l110, lvlmpabbasid            */
const LABEL_SOURCE = 'name';

const RECENT_KEY = 'bf6.recent.v1';
const RECENT_MAX = 6;

const SAVED_KEY = 'bf6.saved.v1';
const SAVED_MAX = 12;

/* Shown on first load so the page is never empty. */
const DEFAULT_PLAYER = { name: 'offroad89', platform: 'steam' };

const PLATFORMS = [
    ['ea', 'EA App'],
    ['steam', 'Steam'],
    ['ps5', 'PlayStation 5'],
    ['ps4', 'PlayStation 4'],
    ['xboxseries', 'Xbox Series'],
    ['xboxone', 'Xbox One'],
    ['pc', 'PC (Origin)'],
    ['epic', 'Epic Games'],
    ['xbox', 'Xbox'],
    ['psn', 'PlayStation Network']
];

/* ------------------------------ HELPERS -------------------------------- */

const $ = (id) => document.getElementById(id);

function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
        Object.keys(attrs).forEach((k) => {
            const v = attrs[k];
            if (v === undefined || v === null) return;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k === 'style') node.setAttribute('style', v);
            else if (k === 'dataset') Object.assign(node.dataset, v);
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, String(v));
        });
    }
    (children || []).forEach((c) => {
        if (c === null || c === undefined || c === false) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
}

function clear(node) {
    if (node) node.textContent = '';
    return node;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/* ----------------------------- FORMATTING ------------------------------ */

/* The API returns percentages as "49.66%" while format_values is on its
   default (true), so values must be coerced defensively. Missing keys are
   common (some stat keys are simply absent rather than 0). */
function toNum(v, fallback) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : (fallback || 0);
    if (typeof v === 'string') {
        const n = parseFloat(v.replace('%', '').replace(/,/g, ''));
        return Number.isFinite(n) ? n : (fallback || 0);
    }
    return typeof fallback === 'number' ? fallback : 0;
}

function fmtInt(v) {
    return Math.round(toNum(v)).toLocaleString('en-US');
}

function fmtNum(v, digits) {
    const d = typeof digits === 'number' ? digits : 2;
    return toNum(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPct(v) {
    return fmtNum(v, 1) + '%';
}

/* seconds -> "2d 11h 41m" (the pre-formatted timePlayed string is never parsed) */
function fmtDuration(seconds) {
    let s = Math.round(toNum(seconds));
    if (s <= 0) return '0m';
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    const parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    if (m && !d) parts.push(m + 'm');
    return parts.length ? parts.join(' ') : '0m';
}

function fmtMeters(m) {
    const v = toNum(m);
    if (v >= 1000) return fmtNum(v / 1000, 1) + ' km';
    return fmtInt(v) + ' m';
}

/* ---------------------------- SMALL VISUALS ---------------------------- */

/* Avatar stand-in: no EA avatar images are loaded, so we draw initials on a
   colour derived from the player name. */
function initialsOf(name) {
    const parts = String(name || '?').trim().split(/[\s_\-.]+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colourFor(str) {
    let h = 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'hsl(' + (h % 360) + ', 55%, 38%)';
}

/* -------------------------- LOCAL CACHE / LIMITS ----------------------- */

function cacheGet(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj.t !== 'number') return null;
        if (Date.now() - obj.t > CACHE_TTL_MS) {
            localStorage.removeItem(key);
            return null;
        }
        return obj.v;
    } catch (e) {
        return null; /* private mode or quota exceeded: just skip caching */
    }
}

function cacheSet(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
    } catch (e) {
        /* ignore: caching is a nice-to-have, never required */
    }
}

let lastRequestAt = 0;
let throttleChain = Promise.resolve();

/* Serialised so concurrent apiGet calls queue up instead of all reading the
   same "last request" timestamp and firing together. */
function throttle() {
    throttleChain = throttleChain.then(async () => {
        const wait = THROTTLE_MS - (Date.now() - lastRequestAt);
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
    });
    return throttleChain;
}

/* ------------------------------- API LAYER ----------------------------- */

function ApiError(message, kind, status) {
    const err = new Error(message);
    err.name = 'ApiError';
    err.kind = kind; /* notfound | server | client | timeout | network */
    err.status = status || 0;
    return err;
}

async function apiGet(path, params) {
    const qs = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
        const v = params[k];
        if (v === undefined || v === null || v === '') return;
        if (Array.isArray(v)) v.forEach((item) => qs.append(k, item));
        else qs.set(k, String(v));
    });

    const url = API_BASE + path + (qs.toString() ? '?' + qs.toString() : '');

    const cached = cacheGet(url);
    if (cached !== null) return cached;

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await throttle();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                method: 'GET',
                signal: controller.signal,
                headers: { Accept: 'application/json' }
            });
            clearTimeout(timer);

            if (res.status === 404) {
                let detail = 'Player not found';
                try {
                    const body = await res.json();
                    if (body && body.errors && body.errors.length) detail = body.errors[0];
                } catch (e) { /* keep the default message */ }
                throw ApiError(detail, 'notfound', 404);
            }

            if (!res.ok) {
                lastError = ApiError('API responded with ' + res.status,
                    res.status >= 500 ? 'server' : 'client', res.status);
                continue; /* retry once on 5xx */
            }

            const data = await res.json();
            cacheSet(url, data);
            return data;
        } catch (err) {
            clearTimeout(timer);

            if (err && err.name === 'ApiError') {
                if (err.kind === 'notfound') throw err;
                lastError = err;
                continue;
            }
            if (err && err.name === 'AbortError') {
                lastError = ApiError('Request timed out', 'timeout', 0);
                continue;
            }
            lastError = ApiError('Network request failed', 'network', 0);
            continue;
        }
    }

    throw lastError || ApiError('Request failed', 'unknown', 0);
}

/* Turns a thrown error into user-facing copy. */
function describeError(err) {
    const kind = err && err.kind;
    if (kind === 'notfound') {
        return {
            title: 'Player not found',
            hint: 'The API matches display names exactly, so check the spelling and capitalisation, and try another platform - the same person can exist separately on ea and steam.'
        };
    }
    if (kind === 'server') {
        return {
            title: 'Statistics service is temporarily unavailable',
            hint: 'gametools.network returned a server error (HTTP ' + (err.status || '5xx') + '). This is usually brief, so please retry shortly.'
        };
    }
    if (kind === 'timeout') {
        return {
            title: 'The request timed out',
            hint: 'The API did not answer within 12 seconds. Please try again.'
        };
    }
    if (kind === 'network') {
        return {
            title: 'Could not reach the statistics service',
            hint: 'Check your internet connection and retry.'
        };
    }
    return { title: 'Something went wrong', hint: 'Please try the lookup again.' };
}

/* ------------------------- NORMALISATION LAYER ------------------------- */

/* Some endpoints answer with a bare object, others with a one-element array. */
function unwrap(raw) {
    if (Array.isArray(raw)) return raw[0] || {};
    return raw || {};
}

/* Grouped arrays embed an aggregate row labelled "All" as element 0, which
   would otherwise double-count every total. */
const GROUP_LABEL_KEYS = [
    'mapName', 'className', 'groupName', 'weaponName',
    'gadgetName', 'meleeName', 'archetypeName', 'gamemodeName'
];

function stripAggregate(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => {
        if (!row || typeof row !== 'object') return false;
        return !GROUP_LABEL_KEYS.some((k) => String(row[k] || '').toLowerCase() === 'all');
    });
}

function labelOf(row, primaryKey) {
    if (!row) return '-';
    if (LABEL_SOURCE === 'id') return row.id || row[primaryKey] || '-';
    return row[primaryKey] || row.name || row.id || '-';
}

function numOf(obj, key) {
    return obj && typeof obj === 'object' ? toNum(obj[key]) : 0;
}

/* Normalises the raw /bf6/stats/ payload into a stable shape.
   Note the API's inconsistent field names: headShots is a count while
   headshots is a percentage, and kpm/dpm appear alongside
   killsPerMinute/damagePerMinute. Both spellings are handled. */
function normaliseStats(raw) {
    const d = unwrap(raw);

    return {
        hasResults: d.hasResults !== false,
        player: {
            name: d.userName || '',
            id: d.id,
            userId: d.userId,
            platform: d.platform || d.platformId || ''
        },
        core: {
            kills: toNum(d.kills),
            deaths: toNum(d.deaths),
            killDeath: toNum(d.killDeath),
            infantryKillDeath: toNum(d.infantryKillDeath),
            killsPerMinute: toNum(d.killsPerMinute),
            damagePerMinute: toNum(d.damagePerMinute),
            killsPerMatch: toNum(d.killsPerMatch),
            damagePerMatch: toNum(d.damagePerMatch),
            wins: toNum(d.wins),
            loses: toNum(d.loses),
            winPercent: toNum(d.winPercent),
            accuracy: toNum(d.accuracy),
            headshotKills: toNum(d.headShots),
            headshotPercent: toNum(d.headshots),
            score: toNum(d.score),
            matchesPlayed: toNum(d.matchesPlayed),
            secondsPlayed: toNum(d.secondsPlayed),
            assists: toNum(d.assists),
            killAssists: toNum(d.killAssists),
            damage: toNum(d.damage),
            shotsFired: toNum(d.shotsFired),
            shotsHit: toNum(d.shotsHit),
            revives: toNum(d.revives),
            heals: toNum(d.heals),
            resupplies: toNum(d.resupplies),
            repairs: toNum(d.repairs),
            thrownThrowables: toNum(d.thrownThrowables),
            gadgetsDestoyed: toNum(d.gadgetsDestoyed),
            vehiclesDestroyed: toNum(d.vehiclesDestroyed),
            enemiesSpotted: toNum(d.enemiesSpotted),
            saviorKills: toNum(d.saviorKills),
            playerTakeDowns: toNum(d.playerTakeDowns),
            humanPrecentage: toNum(d.humanPrecentage)
        },
        xp: (Array.isArray(d.XP) && d.XP[0]) ? {
            total: toNum(d.XP[0].total),
            performance: toNum(d.XP[0].performance),
            accolades: toNum(d.XP[0].accolades)
        } : null,
        objective: (d.objective && typeof d.objective === 'object') ? d.objective : null,
        sector: (d.sector && typeof d.sector === 'object') ? d.sector : null,
        inRound: (d.inRound && typeof d.inRound === 'object') ? d.inRound : null,
        dividedKills: (d.dividedKills && typeof d.dividedKills === 'object') ? d.dividedKills : null,
        devidedDamage: (d.devidedDamage && typeof d.devidedDamage === 'object') ? d.devidedDamage : null,
        devidedAssists: (d.devidedAssists && typeof d.devidedAssists === 'object') ? d.devidedAssists : null,
        distance: (d.distanceTraveled && typeof d.distanceTraveled === 'object') ? d.distanceTraveled : null,
        dividedTime: (d.dividedSecondsPlayed && typeof d.dividedSecondsPlayed === 'object') ? d.dividedSecondsPlayed : null,
        bestClass: d.bestClass || null,
        perGamemode: (d.perGamemode && typeof d.perGamemode === 'object') ? d.perGamemode : null,
        perSeason: (d.perSeason && typeof d.perSeason === 'object') ? d.perSeason : null,
        weapons: stripAggregate(d.weapons),
        weaponGroups: stripAggregate(d.weaponGroups),
        vehicles: stripAggregate(d.vehicles),
        vehicleGroups: stripAggregate(d.vehicleGroups),
        vehicleArchetypes: stripAggregate(d.vehicleArchetypes),
        classes: stripAggregate(d.classes),
        maps: stripAggregate(d.maps),
        gameModes: stripAggregate(d.gameModes),
        gameModeGroups: stripAggregate(d.gameModeGroups),
        gadgets: stripAggregate(d.gadgets),
        gadgetGroups: stripAggregate(d.gadgetGroups),
        melee: stripAggregate(d.melee),
        meleeGroups: stripAggregate(d.meleeGroups)
    };
}

/* ------------------------------ RENDER LAYER --------------------------- */

function statCard(label, value, variant, foot) {
    return el('div', { class: 'bf-stat' + (variant ? ' ' + variant : '') }, [
        el('span', { class: 'bf-stat-label', text: label }),
        el('div', { class: 'bf-stat-value', text: value }),
        foot ? el('div', { class: 'bf-stat-foot', text: foot }) : null
    ]);
}

function kvCard(label, value) {
    return el('div', { class: 'bf-stat' }, [
        el('span', { class: 'bf-stat-label', text: label }),
        el('div', { class: 'bf-stat-value small', text: value })
    ]);
}

function barRow(label, value, max, formatted, variant) {
    const width = max > 0 ? Math.max(0, Math.min(100, (toNum(value) / max) * 100)) : 0;
    return el('div', { class: 'bf-bar-row' }, [
        el('div', { class: 'bf-bar-label', title: label, text: label }),
        el('div', { class: 'bf-bar-track' }, [
            el('div', { class: 'bf-bar-fill' + (variant ? ' ' + variant : ''), style: 'width:' + width.toFixed(2) + '%' })
        ]),
        el('div', { class: 'bf-bar-value', text: formatted })
    ]);
}

function renderBarPanel(node, entries, variant) {
    clear(node);
    if (!entries.length) {
        node.appendChild(el('div', { class: 'bf-muted', text: 'No data recorded for this player yet.' }));
        return;
    }
    const max = entries.reduce((m, e) => Math.max(m, toNum(e.value)), 0);
    entries.forEach((e) => node.appendChild(barRow(e.label, e.value, max, e.formatted || fmtInt(e.value), variant)));
}

/* --------------------------- SORTABLE TABLES --------------------------- */

const tableState = {};

function compareValues(a, b, col, dir) {
    let av;
    let bv;
    if (col.sortValue) {
        av = col.sortValue(a);
        bv = col.sortValue(b);
    } else {
        av = a[col.key];
        bv = b[col.key];
    }
    const numeric = !!col.num || typeof av === 'number' || typeof bv === 'number';
    let r;
    if (numeric) {
        r = toNum(av) - toNum(bv);
    } else {
        const as = av === undefined || av === null ? '' : String(av);
        const bs = bv === undefined || bv === null ? '' : String(bv);
        r = as.localeCompare(bs);
    }
    return dir === 'asc' ? r : -r;
}

/* Generic sortable table renderer.
   config: { id, headId, bodyId, columns, rows, defaultSort, defaultDir } */
function buildTable(config) {
    const head = $(config.headId);
    const body = $(config.bodyId);
    if (!head || !body) return;

    const state = tableState[config.id] || (tableState[config.id] = {
        key: config.defaultSort || config.columns[0].key,
        dir: config.defaultDir || 'desc'
    });

    clear(head);
    clear(body);

    if (!config.rows.length) {
        body.appendChild(el('tr', null, [
            el('td', { colspan: String(config.columns.length), class: 'bf-muted', text: 'No data recorded for this player yet.' })
        ]));
        return;
    }

    const activeCol = config.columns.find((c) => c.key === state.key) || config.columns[0];
    const sorted = config.rows.slice().sort((a, b) => compareValues(a, b, activeCol, state.dir));

    config.columns.forEach((col) => {
        const classes = [];
        if (col.num) classes.push('num');
        if (col.sortable !== false) classes.push('sortable');
        if (state.key === col.key) classes.push(state.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
        const th = el('th', { class: classes.join(' '), text: col.label });
        if (col.sortable !== false) {
            th.addEventListener('click', () => {
                if (state.key === col.key) {
                    state.dir = state.dir === 'asc' ? 'desc' : 'asc';
                } else {
                    state.key = col.key;
                    state.dir = col.num ? 'desc' : 'asc';
                }
                buildTable(config);
            });
        }
        head.appendChild(th);
    });

    sorted.forEach((row) => {
        const tr = el('tr');
        config.columns.forEach((col) => {
            const content = col.render ? col.render(row) : row[col.key];
            const classes = [];
            if (col.num) classes.push('num');
            if (col.nameCell) classes.push('name-cell');
            const td = el('td', { class: classes.join(' ') });
            if (content instanceof Node) td.appendChild(content);
            else td.textContent = content === undefined || content === null || content === '' ? '-' : String(content);
            tr.appendChild(td);
        });
        body.appendChild(tr);
    });
}

/* ------------------------------- IDENTITY ------------------------------ */

function renderIdentity(stats, query) {
    const wrap = $('bfIdentity');
    clear(wrap);

    const name = stats.player.name || query.name;
    wrap.appendChild(el('div', {
        class: 'bf-avatar',
        style: 'background:' + colourFor(name),
        text: initialsOf(name)
    }));

    const chips = el('div', { class: 'bf-chips' });
    chips.appendChild(el('span', { class: 'bf-chip accent', text: query.platform }));
    if (stats.player.id) chips.appendChild(el('span', { class: 'bf-chip', text: 'persona ' + stats.player.id }));
    if (appState.seasonLabel) chips.appendChild(el('span', { class: 'bf-chip amber', text: appState.seasonLabel }));
    if (stats.core.matchesPlayed) chips.appendChild(el('span', { class: 'bf-chip', text: fmtInt(stats.core.matchesPlayed) + ' matches' }));
    if (stats.bestClass) {
        const bc = stats.bestClass.className || stats.bestClass.name || '';
        if (bc) chips.appendChild(el('span', { class: 'bf-chip green', text: 'best class: ' + bc }));
    }
    if (!stats.hasResults) chips.appendChild(el('span', { class: 'bf-chip', text: 'no ranked results' }));

    wrap.appendChild(el('div', { class: 'bf-identity-main' }, [
        el('div', { class: 'bf-identity-name', text: name }),
        el('div', {
            class: 'bf-identity-sub',
            text: fmtDuration(stats.core.secondsPlayed) + ' played · ' + fmtInt(stats.core.score) + ' score'
        }),
        chips
    ]));
}

/* ------------------------------- OVERVIEW ------------------------------ */

function renderOverview(stats) {
    const grid = $('bfOverview');
    clear(grid);
    const c = stats.core;

    grid.appendChild(statCard('Kills', fmtInt(c.kills), 'cyan'));
    grid.appendChild(statCard('Deaths', fmtInt(c.deaths)));
    grid.appendChild(statCard('K/D', fmtNum(c.killDeath), c.killDeath >= 1 ? 'green' : 'red'));
    grid.appendChild(statCard('Infantry K/D', fmtNum(c.infantryKillDeath), c.infantryKillDeath >= 1 ? 'green' : 'red'));
    grid.appendChild(statCard('Kills / min', fmtNum(c.killsPerMinute)));
    grid.appendChild(statCard('Damage / min', fmtNum(c.damagePerMinute)));
    grid.appendChild(statCard('Kills / match', fmtNum(c.killsPerMatch)));
    grid.appendChild(statCard('Damage / match', fmtInt(c.damagePerMatch)));
    grid.appendChild(statCard('Wins', fmtInt(c.wins), 'green'));
    grid.appendChild(statCard('Losses', fmtInt(c.loses), 'red'));
    grid.appendChild(statCard('Win rate', fmtPct(c.winPercent), c.winPercent >= 50 ? 'green' : 'red'));
    grid.appendChild(statCard('Accuracy', fmtPct(c.accuracy)));
    grid.appendChild(statCard('Headshot rate', fmtPct(c.headshotPercent), 'amber', fmtInt(c.headshotKills) + ' headshot kills'));
    grid.appendChild(statCard('Score', fmtInt(c.score), 'accent'));
    grid.appendChild(statCard('Total XP', stats.xp ? fmtInt(stats.xp.total) : '-', 'accent'));
    grid.appendChild(statCard('Matches', fmtInt(c.matchesPlayed)));
    grid.appendChild(statCard('Playtime', fmtDuration(c.secondsPlayed), null, fmtInt(c.secondsPlayed) + ' seconds'));
    grid.appendChild(statCard('Assists', fmtInt(c.assists)));
    grid.appendChild(statCard('Revives', fmtInt(c.revives)));
    grid.appendChild(statCard('Heals', fmtInt(c.heals)));
    grid.appendChild(statCard('Resupplies', fmtInt(c.resupplies)));
    grid.appendChild(statCard('Repairs', fmtInt(c.repairs)));
    grid.appendChild(statCard('Enemies spotted', fmtInt(c.enemiesSpotted)));
    grid.appendChild(statCard('Vehicles destroyed', fmtInt(c.vehiclesDestroyed)));
    grid.appendChild(statCard('Damage dealt', fmtInt(c.damage)));
    grid.appendChild(statCard('Shots hit', fmtInt(c.shotsHit), null, 'of ' + fmtInt(c.shotsFired) + ' fired'));
    grid.appendChild(statCard('Gadgets destroyed', fmtInt(c.gadgetsDestoyed)));
    grid.appendChild(statCard('Human kills', fmtPct(c.humanPrecentage), null, 'share of kills on real players'));
}

/* --------------------------- CARD GRID HELPER -------------------------- */

function renderCardGrid(node, items) {
    clear(node);
    const grid = el('div', { class: 'bf-stat-grid tight' });
    items.forEach((pair) => {
        if (!pair) return;
        grid.appendChild(kvCard(pair[0], pair[1]));
    });
    node.appendChild(grid);
}

/* ------------------------------- CAREER -------------------------------- */

const KILL_LABELS = [
    ['confirmed', 'Confirmed kills'],
    ['fullConfirmed', 'Full confirmed kills'],
    ['ads', 'ADS kills'],
    ['hipfire', 'Hipfire kills'],
    ['grenades', 'Grenade kills'],
    ['longDistance', 'Long distance kills'],
    ['melee', 'Melee kills'],
    ['multiKills', 'Multi kills'],
    ['vehicle', 'Kills from vehicles'],
    ['passenger', 'Kills as passenger'],
    ['roadkills', 'Roadkills'],
    ['parachute', 'Parachute kills']
];

const DAMAGE_LABELS = [
    ['human', 'Damage to infantry'],
    ['explosive', 'Explosive damage'],
    ['toVehicle', 'Damage to vehicles'],
    ['withVehicle', 'Damage with vehicles'],
    ['vehicleDriver', 'Damage as vehicle driver'],
    ['passenger', 'Damage as passenger'],
    ['inRound', 'Damage (in round)']
];

const ASSIST_LABELS = [
    ['human', 'Assists on infantry'],
    ['spot', 'Spot assists'],
    ['driver', 'Driver assists'],
    ['passenger', 'Passenger assists'],
    ['pilot', 'Pilot assists'],
    ['inRound', 'Assists (in round)']
];

function renderCareer(stats) {
    const o = stats.objective || {};
    const ot = o.time || {};
    const sec = stats.sector || {};
    const ir = stats.inRound || {};
    const dist = stats.distance || {};
    const dt = stats.dividedTime || {};
    const c = stats.core;

    renderCardGrid($('bfCareer'), [
        ['Objective time (total)', fmtDuration(ot.total)],
        ['Objective time attacking', fmtDuration(ot.attacked)],
        ['Objective time defending', fmtDuration(ot.defended)],
        ['Objectives captured', fmtInt(o.captured)],
        ['Objectives neutralized', fmtInt(o.neutralized)],
        ['Objectives armed', fmtInt(o.armed)],
        ['Objectives defused', fmtInt(o.defused)],
        ['Objectives destroyed', fmtInt(o.destroyed)],
        ['Sectors captured', fmtInt(sec.captured)],
        ['Savior kills', fmtInt(c.saviorKills)],
        ['Kill assists', fmtInt(c.killAssists)],
        ['Takedowns', fmtInt(c.playerTakeDowns)],
        ['Throwables thrown', fmtInt(c.thrownThrowables)],
        ['Distance on foot', fmtMeters(dist.foot)],
        ['Distance in vehicles', fmtMeters(dist.vehicle)],
        ['Distance as passenger', fmtMeters(dist.passenger)],
        ['Time flying', fmtDuration(dt.flying)],
        ['Time driving', fmtDuration(dt.driving)],
        ['Shots fired', fmtInt(c.shotsFired)],
        ['XP from performance', stats.xp ? fmtInt(stats.xp.performance) : '-'],
        ['XP from accolades', stats.xp ? fmtInt(stats.xp.accolades) : '-'],
        ['Revives (in round)', fmtInt(ir.revives)],
        ['Resupplies (in round)', fmtInt(ir.resupplies)],
        ['Spot assists (in round)', fmtInt(ir.spotAssists)],
        ['Throwables (in round)', fmtInt(ir.thrownThrowables)]
    ]);
}

/* --------------------------- KILL BREAKDOWN ---------------------------- */

function collectBreakdown(src, map) {
    if (!src) return [];
    return map.map((pair) => ({
        label: pair[1],
        value: numOf(src, pair[0]),
        formatted: fmtInt(numOf(src, pair[0]))
    }));
}

function renderDamageBreakdown(stats) {
    const node = $('bfDamageBreakdown');
    clear(node);

    const damage = collectBreakdown(stats.devidedDamage, DAMAGE_LABELS);
    const assists = collectBreakdown(stats.devidedAssists, ASSIST_LABELS);

    if (!damage.length && !assists.length) {
        node.appendChild(el('div', { class: 'bf-muted', text: 'No data recorded for this player yet.' }));
        return;
    }

    const damageMax = damage.reduce((m, e) => Math.max(m, e.value), 0);
    const assistMax = assists.reduce((m, e) => Math.max(m, e.value), 0);

    node.appendChild(el('div', { class: 'bf-bar-subhead', text: 'Damage by source' }));
    damage.forEach((e) => node.appendChild(barRow(e.label, e.value, damageMax, fmtInt(e.value), 'warm')));

    if (assists.length) {
        node.appendChild(el('div', { class: 'bf-bar-subhead', text: 'Assists by type' }));
        assists.forEach((e) => node.appendChild(barRow(e.label, e.value, assistMax, fmtInt(e.value), 'good')));
    }
}

/* ------------------------------- WEAPONS ------------------------------- */

function renderWeapons(stats) {
    $('bfWeaponCount').textContent = stats.weapons.length + ' weapons tracked';

    buildTable({
        id: 'weapons',
        headId: 'bfWeaponsHead',
        bodyId: 'bfWeaponsBody',
        defaultSort: 'kills',
        defaultDir: 'desc',
        rows: stats.weapons,
        columns: [
            {
                key: 'weaponName',
                label: 'Weapon',
                nameCell: true,
                render: (r) => labelOf(r, 'weaponName')
            },
            {
                key: 'type',
                label: 'Type',
                render: (r) => el('span', { class: 'bf-badge type-weapon', text: r.type || '-' })
            },
            { key: 'kills', label: 'Kills', num: true, render: (r) => fmtInt(r.kills) },
            { key: 'killsPerMinute', label: 'KPM', num: true, render: (r) => fmtNum(r.killsPerMinute) },
            { key: 'accuracy', label: 'Accuracy', num: true, render: (r) => fmtPct(r.accuracy) },
            { key: 'headshots', label: 'HS %', num: true, render: (r) => fmtPct(r.headshots) },
            { key: 'headshotKills', label: 'HS kills', num: true, render: (r) => fmtInt(r.headshotKills) },
            { key: 'damage', label: 'Damage', num: true, render: (r) => fmtInt(r.damage) },
            { key: 'shotsHit', label: 'Hits', num: true, render: (r) => fmtInt(r.shotsHit) },
            { key: 'shotsFired', label: 'Shots', num: true, render: (r) => fmtInt(r.shotsFired) },
            { key: 'timeEquipped', label: 'Equipped', num: true, render: (r) => fmtDuration(r.timeEquipped) }
        ]
    });
}

function renderWeaponGroups(stats) {
    const entries = stats.weaponGroups.map((g) => ({
        label: labelOf(g, 'groupName'),
        value: toNum(g.kills),
        formatted: fmtInt(g.kills) + ' kills'
    }));
    renderBarPanel($('bfWeaponGroups'), entries);
}

/* ------------------------------- CLASSES ------------------------------- */

function renderClasses(stats) {
    const node = $('bfClasses');
    clear(node);

    if (!stats.classes.length) {
        node.appendChild(el('div', { class: 'bf-muted', text: 'No data recorded for this player yet.' }));
        return;
    }

    const maxKills = stats.classes.reduce((m, c) => Math.max(m, toNum(c.kills)), 0);

    const ordered = stats.classes.slice().sort((a, b) => toNum(b.kills) - toNum(a.kills));
    ordered.forEach((c) => {
        const label = labelOf(c, 'className');
        node.appendChild(barRow(
            label,
            c.kills,
            maxKills,
            fmtInt(c.kills) + ' / ' + fmtNum(c.killDeath) + ' K/D',
            'good'
        ));

        const meta = el('div', { class: 'bf-bar-meta' }, [
            el('span', { text: fmtInt(c.spawns) + ' spawns' }),
            el('span', { text: fmtNum(c.kpm) + ' KPM' }),
            el('span', { text: fmtInt(c.assists) + ' assists' }),
            el('span', { text: fmtInt(c.revives) + ' revives' }),
            el('span', { text: fmtInt(c.score) + ' score' }),
            el('span', { text: fmtDuration(c.secondsPlayed) })
        ]);
        node.appendChild(meta);
    });
}

/* ----------------------------- GAME MODES ------------------------------ */

function renderGameModes(stats) {
    buildTable({
        id: 'gamemodes',
        headId: 'bfGameModesHead',
        bodyId: 'bfGameModesBody',
        defaultSort: 'matches',
        rows: stats.gameModes,
        columns: [
            { key: 'gamemodeName', label: 'Mode', nameCell: true, render: (r) => labelOf(r, 'gamemodeName') },
            { key: 'matches', label: 'Matches', num: true, render: (r) => fmtInt(r.matches) },
            { key: 'wins', label: 'W', num: true, render: (r) => fmtInt(r.wins) },
            { key: 'losses', label: 'L', num: true, render: (r) => fmtInt(r.losses) },
            { key: 'winPercent', label: 'Win %', num: true, render: (r) => fmtPct(r.winPercent) },
            { key: 'kills', label: 'Kills', num: true, render: (r) => fmtInt(r.kills) },
            { key: 'killDeath', label: 'K/D', num: true, render: (r) => fmtNum(r.killDeath) },
            { key: 'secondsPlayed', label: 'Time', num: true, render: (r) => fmtDuration(r.secondsPlayed) }
        ]
    });
}

/* --------------------------------- MAPS -------------------------------- */

function renderMaps(stats) {
    buildTable({
        id: 'maps',
        headId: 'bfMapsHead',
        bodyId: 'bfMapsBody',
        defaultSort: 'matches',
        rows: stats.maps,
        columns: [
            { key: 'mapName', label: 'Map', nameCell: true, render: (r) => labelOf(r, 'mapName') },
            { key: 'matches', label: 'Matches', num: true, render: (r) => fmtInt(r.matches) },
            { key: 'wins', label: 'W', num: true, render: (r) => fmtInt(r.wins) },
            { key: 'losses', label: 'L', num: true, render: (r) => fmtInt(r.losses) },
            { key: 'winPercent', label: 'Win %', num: true, render: (r) => fmtPct(r.winPercent) },
            { key: 'secondsPlayed', label: 'Time', num: true, render: (r) => fmtDuration(r.secondsPlayed) }
        ]
    });
}

/* ------------------------------ VEHICLES ------------------------------- */

function renderVehicles(stats) {
    /* Vehicles and archetypes are merged into one table: archetypes carry the
       group-level totals while individual vehicles carry the per-chassis rows. */
    const rows = [];
    stats.vehicleArchetypes.forEach((a) => {
        rows.push({
            kind: 'Archetype',
            name: labelOf(a, 'archetypeName'),
            kills: a.kills,
            killsPerMinute: a.killsPerMinute,
            damage: a.damage,
            destroyed: a.destroyed,
            roadKills: a.roadKills,
            multiKills: a.multiKills,
            timeIn: a.timeIn,
            distanceTraveled: a.distanceTraveled,
            spawns: a.spawns
        });
    });
    stats.vehicles.forEach((v) => {
        rows.push({
            kind: 'Vehicle',
            name: labelOf(v, 'vehicleName'),
            kills: v.kills,
            killsPerMinute: v.killsPerMinute,
            damage: v.damageTo,
            destroyed: v.destroyed,
            roadKills: v.roadKills,
            multiKills: v.multiKills,
            timeIn: v.timeIn,
            distanceTraveled: v.distanceTraveled,
            spawns: v.spawns
        });
    });

    buildTable({
        id: 'vehicles',
        headId: 'bfVehiclesHead',
        bodyId: 'bfVehiclesBody',
        defaultSort: 'kills',
        rows: rows,
        columns: [
            { key: 'name', label: 'Name', nameCell: true, render: (r) => r.name },
            {
                key: 'kind',
                label: 'Kind',
                render: (r) => el('span', { class: 'bf-badge type-vehicle', text: r.kind })
            },
            { key: 'kills', label: 'Kills', num: true, render: (r) => fmtInt(r.kills) },
            { key: 'killsPerMinute', label: 'KPM', num: true, render: (r) => fmtNum(r.killsPerMinute) },
            { key: 'damage', label: 'Damage', num: true, render: (r) => fmtInt(r.damage) },
            { key: 'destroyed', label: 'Destroyed', num: true, render: (r) => fmtInt(r.destroyed) },
            { key: 'roadKills', label: 'Roadkills', num: true, render: (r) => fmtInt(r.roadKills) },
            { key: 'multiKills', label: 'Multi', num: true, render: (r) => fmtInt(r.multiKills) },
            { key: 'spawns', label: 'Spawns', num: true, render: (r) => fmtInt(r.spawns) },
            { key: 'distanceTraveled', label: 'Distance', num: true, render: (r) => fmtMeters(r.distanceTraveled) },
            { key: 'timeIn', label: 'Time in', num: true, render: (r) => fmtDuration(r.timeIn) }
        ]
    });
}

/* ------------------------------- GADGETS ------------------------------- */

function renderGadgets(stats) {
    buildTable({
        id: 'gadgets',
        headId: 'bfGadgetsHead',
        bodyId: 'bfGadgetsBody',
        defaultSort: 'uses',
        rows: stats.gadgets,
        columns: [
            { key: 'gadgetName', label: 'Gadget', nameCell: true, render: (r) => labelOf(r, 'gadgetName') },
            {
                key: 'type',
                label: 'Type',
                render: (r) => el('span', { class: 'bf-badge type-gadget', text: r.type || '-' })
            },
            { key: 'uses', label: 'Uses', num: true, render: (r) => fmtInt(r.uses) },
            { key: 'kills', label: 'Kills', num: true, render: (r) => fmtInt(r.kills) },
            { key: 'damage', label: 'Damage', num: true, render: (r) => fmtInt(r.damage) },
            { key: 'assists', label: 'Assists', num: true, render: (r) => fmtInt(r.assists) },
            { key: 'spots', label: 'Spots', num: true, render: (r) => fmtInt(r.spots) },
            { key: 'repairs', label: 'Repairs', num: true, render: (r) => fmtInt(r.repairs) },
            { key: 'vehiclesDestroyedWith', label: 'Veh. destr.', num: true, render: (r) => fmtInt(r.vehiclesDestroyedWith) },
            { key: 'spawns', label: 'Spawns', num: true, render: (r) => fmtInt(r.spawns) },
            { key: 'secondsPlayed', label: 'Time', num: true, render: (r) => fmtDuration(r.secondsPlayed) }
        ]
    });
}

/* -------------------------------- MELEE -------------------------------- */

function renderMelee(stats) {
    const node = $('bfMelee');
    clear(node);

    if (!stats.melee.length) {
        node.appendChild(el('div', { class: 'bf-muted', text: 'No data recorded for this player yet.' }));
        return;
    }

    const max = stats.melee.reduce((m, x) => Math.max(m, toNum(x.uses)), 0);
    stats.melee.forEach((m) => {
        node.appendChild(barRow(labelOf(m, 'meleeName'), m.uses, max,
            fmtInt(m.kills) + ' kills · ' + fmtInt(m.uses) + ' uses'));
        node.appendChild(el('div', { class: 'bf-bar-meta' }, [
            el('span', { text: m.type || 'Melee' }),
            el('span', { text: fmtNum(m.killsPerMinute) + ' KPM' }),
            el('span', { text: fmtInt(m.takedowns) + ' takedowns' }),
            el('span', { text: fmtInt(m.damage) + ' damage' }),
            el('span', { text: fmtDuration(m.timeEquipped) + ' equipped' })
        ]));
    });
}

/* -------------------------- INLINE SVG CHART --------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
        Object.keys(attrs).forEach((k) => {
            const v = attrs[k];
            if (v === undefined || v === null) return;
            node.setAttribute(k, String(v));
        });
    }
    return node;
}

function shortStamp(iso, withDate) {
    const s = String(iso || '');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return s;
    return withDate ? (m[3] + '/' + m[2] + ' ' + m[4] + ':' + m[5]) : (m[4] + ':' + m[5]);
}

/* Hand-drawn line/area chart - deliberately no chart library so that the
   page ships zero third-party assets. */
function renderActivityChart(payload) {
    const svg = $('bfActivitySvg');
    const legend = $('bfActivityLegend');
    clear(svg);
    clear(legend);

    const amounts = Array.isArray(payload.soldierAmount) ? payload.soldierAmount.map((v) => toNum(v)) : [];
    const stamps = Array.isArray(payload.timeStamps) ? payload.timeStamps : [];

    if (!amounts.length) {
        legend.appendChild(el('span', { text: 'No activity samples were returned for this period.' }));
        return;
    }

    const W = 1000;
    const H = 220;
    const padT = 14;
    const padB = 28;
    const padX = 10;
    const plotH = H - padT - padB;
    const n = amounts.length;
    const maxVal = Math.max(1, amounts.reduce((m, v) => Math.max(m, v), 0));
    const stepX = n > 1 ? (W - padX * 2) / (n - 1) : 0;
    const xFor = (i) => padX + i * stepX;
    const yFor = (v) => padT + plotH * (1 - (v / maxVal));

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'bfAreaGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#38bdf8', 'stop-opacity': '0.45' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#38bdf8', 'stop-opacity': '0' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    /* horizontal grid + y axis labels */
    for (let g = 0; g <= 4; g++) {
        const y = padT + (plotH * g) / 4;
        svg.appendChild(svgEl('line', {
            x1: 0, y1: y, x2: W, y2: y,
            stroke: '#283548', 'stroke-width': '1',
            'stroke-dasharray': g === 4 ? '' : '3 5',
            'vector-effect': 'non-scaling-stroke'
        }));
        svg.appendChild(svgEl('text', {
            x: 2, y: y - 3, fill: '#94a3b8', 'font-size': '11'
        })).textContent = fmtInt(maxVal * (1 - g / 4));
    }

    /* area + line */
    const points = amounts.map((v, i) => xFor(i).toFixed(1) + ',' + yFor(v).toFixed(1));
    svg.appendChild(svgEl('path', {
        d: 'M ' + padX + ',' + (H - padB) + ' L ' + points.join(' L ') + ' L ' + xFor(n - 1).toFixed(1) + ',' + (H - padB) + ' Z',
        fill: 'url(#bfAreaGrad)',
        stroke: 'none'
    }));
    svg.appendChild(svgEl('path', {
        d: 'M ' + points.join(' L '),
        fill: 'none',
        stroke: '#38bdf8',
        'stroke-width': '2',
        'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke'
    }));

    /* hoverable samples */
    const labelInside = n <= 24;
    amounts.forEach((v, i) => {
        const c = svgEl('circle', {
            cx: xFor(i).toFixed(1), cy: yFor(v).toFixed(1), r: '2.6',
            fill: '#0b0f19', stroke: '#38bdf8', 'stroke-width': '1.5',
            'vector-effect': 'non-scaling-stroke'
        });
        c.appendChild(svgEl('title')).textContent = shortStamp(stamps[i], true) + ' UTC - ' + fmtInt(v) + ' players in match';
        svg.appendChild(c);
    });

    /* a few x axis labels */
    const labelIdx = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);
    labelIdx.forEach((i) => {
        const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
        svg.appendChild(svgEl('text', {
            x: xFor(i).toFixed(1), y: H - 8, fill: '#94a3b8', 'font-size': '11', 'text-anchor': anchor
        })).textContent = shortStamp(stamps[i], !labelInside);
    });

    legend.appendChild(el('span', null, [
        el('i', { style: 'background:#38bdf8' }),
        document.createTextNode('Players in match (peak ' + fmtInt(maxVal) + ')')
    ]));
    legend.appendChild(el('span', {
        text: 'Hourly samples · ' + n + ' points · source: /bf6/statusarray/'
    }));
}

/* --------------------------- PROFILE (/bf6/profile/) -------------------- */

const MODE_TIME_LABELS = {
    bt: 'Breakthrough',
    cq: 'Conquest',
    esc: 'Escalation',
    rush: 'Rush',
    dom: 'Domination',
    koth: 'King of the Hill'
};

const CLASS_TIME_LABELS = {
    assault: 'Assault',
    support: 'Support',
    engineer: 'Engineer',
    recon: 'Recon'
};

const WEAPON_CLASS_KILL_LABELS = {
    ar: 'Assault rifles',
    mg: 'Machine guns',
    crb: 'Carbines',
    smg: 'SMGs',
    dmr: 'DMR',
    pst: 'Pistols',
    snr: 'Sniper rifles',
    snp: 'Sniper rifles',
    shtgn: 'Shotguns',
    shot: 'Shotguns',
    lch: 'Launchers',
    thrw: 'Throwables'
};

function titleToken(tok) {
    if (!tok) return '';
    if (tok.length <= 3) return tok.toUpperCase();
    return tok.charAt(0).toUpperCase() + tok.slice(1);
}

function humanise(suffix) {
    return String(suffix || '').split(/[_\s]+/).filter(Boolean).map(titleToken).join(' ');
}

/* The profile stats array holds ~339 entries with duplicated names and many
   nulls. Keep the first non-null value seen for each name. */
function collectProfileStats(list) {
    const map = Object.create(null);
    (Array.isArray(list) ? list : []).forEach((s) => {
        if (!s || !s.name) return;
        if (map[s.name] === undefined && s.value !== null && s.value !== undefined) {
            map[s.name] = s.value;
        }
    });
    return map;
}

function statOr(map, key) {
    return map[key] === undefined ? null : toNum(map[key]);
}

function prefixedList(map, prefix, labelMap) {
    const out = [];
    Object.keys(map).forEach((k) => {
        if (k.indexOf(prefix) !== 0) return;
        const rest = k.slice(prefix.length);
        if (!rest) return;
        const v = toNum(map[k]);
        if (!isFinite(v)) return;
        out.push({ label: (labelMap && labelMap[rest]) || humanise(rest), value: v });
    });
    return out;
}

function collectWeaponClassKills(map) {
    const out = [];
    Object.keys(map).forEach((k) => {
        const m = /^kills_(.+)_total$/.exec(k);
        if (!m) return;
        const v = toNum(map[k]);
        if (!isFinite(v)) return;
        out.push({ label: WEAPON_CLASS_KILL_LABELS[m[1]] || humanise(m[1]), value: v });
    });
    return out;
}

function normaliseProfile(raw) {
    const list = raw && Array.isArray(raw.playerProfiles) ? raw.playerProfiles : [];
    if (!list.length || !list[0]) return null;
    const prof = list[0];
    const map = collectProfileStats(prof.stats);

    const card = (prof.playerCard && typeof prof.playerCard === 'object') ? prof.playerCard : {};
    const dogTags = (prof.totalDogTags && typeof prof.totalDogTags === 'object') ? prof.totalDogTags : {};
    const badgeSummary = (prof.badgeSummary && typeof prof.badgeSummary === 'object') ? prof.badgeSummary : {};

    return {
        rankName: typeof prof.rankName === 'string' ? prof.rankName : null,
        rankLevel: card.rank === undefined || card.rank === null ? null : toNum(card.rank),
        cardBadges: card.badges === undefined || card.badges === null ? null : toNum(card.badges),
        dogTags: dogTags.intValue === undefined || dogTags.intValue === null ? null : toNum(dogTags.intValue),
        badgeTotal: badgeSummary.totalBadges === undefined || badgeSummary.totalBadges === null
            ? null : toNum(badgeSummary.totalBadges),
        badges: Array.isArray(badgeSummary.badges) ? badgeSummary.badges : [],
        competitive: (Array.isArray(prof.competitiveRanks) ? prof.competitiveRanks : [])
            .map((r) => ({
                mode: (r && (r.modeName || r.mode)) || 'Ranked',
                rank: (r && r.rankName) || 'Unranked'
            }))
            .filter((r) => r.mode),
        bestKillstreak: statOr(map, 'killstreak_longest_Total'),
        longestKill: statOr(map, 'kill_longDist_last_cb'),
        matches: statOr(map, 'matches_level'),
        wins: statOr(map, 'wins_level'),
        losses: statOr(map, 'losses_level'),
        vehicleSeconds: statOr(map, 'tp_veh'),
        kitTime: prefixedList(map, 'tp_kit_', CLASS_TIME_LABELS),
        modeTime: prefixedList(map, 'tp_gm_', MODE_TIME_LABELS),
        weaponKills: collectWeaponClassKills(map)
    };
}

/* ------------------------------ HIGHLIGHTS ----------------------------- */

function renderHighlights(profile) {
    const node = $('bfHighlights');
    const src = $('bfHighlightsSource');
    clear(node);

    if (!profile) {
        if (src) src.textContent = '';
        node.appendChild(el('div', {
            class: 'bf-muted',
            text: 'Profile details are unavailable for this player — the /bf6/profile/ endpoint returned no records.'
        }));
        return;
    }

    if (src) src.textContent = 'source: /bf6/profile/';

    const cards = [];
    if (profile.rankName) cards.push(['Current rank', profile.rankName]);
    if (profile.rankLevel !== null) cards.push(['Rank level', fmtInt(profile.rankLevel)]);
    if (profile.matches !== null) cards.push(['Matches played', fmtInt(profile.matches)]);
    if (profile.bestKillstreak !== null) cards.push(['Best killstreak', fmtInt(profile.bestKillstreak)]);
    if (profile.longestKill !== null) cards.push(['Longest kill distance', fmtInt(profile.longestKill)]);
    if (profile.dogTags !== null) cards.push(['Dog tags collected', fmtInt(profile.dogTags)]);
    if (profile.badgeTotal !== null) cards.push(['Badges earned', fmtInt(profile.badgeTotal)]);
    if (profile.cardBadges !== null) cards.push(['Card badges', fmtInt(profile.cardBadges)]);
    if (profile.wins !== null && profile.losses !== null) {
        cards.push(['Record (W / L)', fmtInt(profile.wins) + ' / ' + fmtInt(profile.losses)]);
    }
    if (profile.vehicleSeconds !== null && profile.vehicleSeconds > 0) {
        cards.push(['Vehicle time', fmtDuration(profile.vehicleSeconds)]);
    }

    if (cards.length) {
        node.appendChild(el('div', { class: 'bf-stat-grid tight' },
            cards.map((c) => kvCard(c[0], c[1]))));
    }

    if (profile.competitive.length) {
        node.appendChild(el('div', { class: 'bf-bar-subhead', text: 'Ranked / competitive' }));
        profile.competitive.forEach((r) => {
            node.appendChild(el('div', { class: 'bf-comp-row' }, [
                el('span', { class: 'bf-comp-mode', text: r.mode }),
                el('span', { class: 'bf-comp-rank', text: r.rank })
            ]));
        });
    }

    if (profile.badges.length) {
        node.appendChild(el('div', { class: 'bf-bar-subhead', text: 'Top badges' }));
        const wrap = el('div', { class: 'bf-chip-row' });
        profile.badges.slice(0, 8).forEach((b) => {
            wrap.appendChild(el('span', {
                class: 'bf-badge',
                title: b.badgeId || '',
                text: 'Tier ' + (toNum(b.tier) || 1) + ' · ' + toNum(b.progress) + '%'
            }));
        });
        node.appendChild(wrap);
    }

    if (!cards.length && !profile.competitive.length && !profile.badges.length) {
        node.appendChild(el('div', { class: 'bf-muted', text: 'No highlight data recorded for this player yet.' }));
    }
}

/* ------------------------ SHARE / DISTRIBUTION BARS -------------------- */

function renderSharePanel(node, entries, fmt) {
    clear(node);
    const live = (entries || []).filter((e) => e && toNum(e.value) > 0);
    if (!live.length) {
        node.appendChild(el('div', { class: 'bf-muted', text: 'No data recorded for this player yet.' }));
        return;
    }
    live.sort((a, b) => toNum(b.value) - toNum(a.value));
    const total = live.reduce((s, e) => s + toNum(e.value), 0);
    const max = live.reduce((m, e) => Math.max(m, toNum(e.value)), 0);
    live.forEach((e) => {
        const share = total > 0 ? ((toNum(e.value) / total) * 100).toFixed(1) : '0.0';
        node.appendChild(barRow(e.label, e.value, max,
            (fmt ? fmt(e.value) : fmtInt(e.value)) + ' · ' + share + '%'));
    });
}

function renderClassTime(profile) {
    renderSharePanel($('bfClassTime'), profile ? profile.kitTime : [], fmtDuration);
}

function renderModeTime(profile) {
    const entries = profile ? profile.modeTime.slice() : [];
    if (profile && profile.vehicleSeconds > 0) {
        entries.push({ label: 'Vehicles', value: profile.vehicleSeconds });
    }
    renderSharePanel($('bfModeTime'), entries, fmtDuration);
}

function renderWeaponClassKills(profile) {
    renderSharePanel($('bfWeaponClassKills'), profile ? profile.weaponKills : [], fmtInt);
}

/* --------------------------- MODE COMPARISON --------------------------- */

function collectModes(perGamemode) {
    if (!perGamemode || typeof perGamemode !== 'object') return [];
    return Object.keys(perGamemode).map((key) => {
        const m = perGamemode[key];
        if (!m || typeof m !== 'object') return null;
        return {
            label: m.gamemodeName || humanise(String(key).replace(/\d+$/, '')),
            kd: toNum(m.killDeath),
            winPercent: toNum(m.winPercent),
            accuracy: toNum(m.accuracy),
            kills: toNum(m.kills),
            matches: toNum(m.matchesPlayed)
        };
    }).filter((m) => m && (m.matches > 0 || m.kills > 0));
}

function renderModeCompare(stats) {
    const node = $('bfModeCompare');
    clear(node);
    const modes = collectModes(stats.perGamemode);
    const count = $('bfModeCompareCount');
    if (count) count.textContent = modes.length ? modes.length + ' modes reported' : '';

    if (!modes.length) {
        node.appendChild(el('div', { class: 'bf-muted', text: 'No per-mode breakdown available for this player.' }));
        return;
    }

    const maxKd = Math.max(1, modes.reduce((m, x) => Math.max(m, x.kd), 0));

    modes.forEach((m) => {
        node.appendChild(el('div', { class: 'bf-bar-subhead' }, [
            el('span', { text: m.label }),
            el('span', { class: 'bf-muted', text: fmtInt(m.matches) + ' matches · ' + fmtInt(m.kills) + ' kills' })
        ]));
        node.appendChild(barRow('K/D', m.kd, maxKd, fmtNum(m.kd)));
        node.appendChild(barRow('Win rate', m.winPercent, 100, fmtPct(m.winPercent), 'good'));
        node.appendChild(barRow('Accuracy', m.accuracy, 100, fmtPct(m.accuracy), 'warm'));
    });

    /* The API perGamemode block is only a partial sample: it drops modes the
       player has played and its totals never reach the career totals. Say so
       instead of letting the bars read as lifetime per-mode figures. */
    const covered = modes.reduce((s, m) => s + m.matches, 0);
    const career = toNum(stats.core.matchesPlayed);

    /* Always state the coverage, partial or complete. Staying silent when the
       numbers looked plausible is exactly what made this panel read as a
       lifetime per-mode breakdown when it is not one. */
    if (career > 0) {
        node.appendChild(el('div', {
            class: 'bf-muted',
            style: 'margin-top:10px;',
            text: covered < career
                ? 'Partial API sample: these ' + fmtInt(covered) + ' of ' + fmtInt(career)
                    + ' career matches (' + Math.round((covered / career) * 100)
                    + '%) are all the API reports per mode. Any mode it does not list is missing entirely, '
                    + 'so read these bars as a subset rather than as lifetime per-mode totals. '
                    + 'The Maps, Weapons and Team Play panels, by contrast, cover every match.'
                : 'Covers all ' + fmtInt(career) + ' career matches, so these per-mode bars are complete.'
        }));
    }
}

/* --------------------- MAPS / PLAYSTYLE / SUPPORT ---------------------- */
/* Three views the career table only ever showed as bare numbers. All three
   read fields that reconcile with the career totals, unlike perGamemode. */

function renderMapPerformance(stats) {
    const node = $('bfMapPerf');
    if (!node) return;
    clear(node);

    const rows = (stats.maps || []).filter((m) => toNum(m.matches) > 0);
    if (!rows.length) {
        node.appendChild(el('div', { class: 'bf-muted', text: 'No per-map data recorded for this player yet.' }));
        return;
    }

    rows.slice()
        .sort((a, b) => toNum(b.winPercent) - toNum(a.winPercent))
        .forEach((m) => node.appendChild(barRow(
            labelOf(m, 'mapName'),
            toNum(m.winPercent),
            100,
            fmtPct(m.winPercent) + ' \u00b7 ' + fmtInt(m.matches) + ' played',
            toNum(m.winPercent) >= 50 ? 'good' : 'warm'
        )));
}

function renderAimStyle(stats) {
    const svg = $('bfAimDonutSvg');
    const legend = $('bfAimDonutLegend');
    const node = $('bfKillContext');
    if (!svg || !legend || !node) return;

    const dk = stats.dividedKills || {};
    const ads = numOf(dk, 'ads');
    const hip = numOf(dk, 'hipfire');

    renderDonut(
        svg, legend,
        [
            { label: 'Aimed down sights', value: ads, color: CHART_COLORS[0] },
            { label: 'Hipfire', value: hip, color: CHART_COLORS[2] }
        ],
        fmtCompact(ads + hip),
        'weapon kills'
    );

    clear(node);
    const total = toNum(stats.core.kills);
    const parts = [
        { label: 'Long-range kills', value: numOf(dk, 'longDistance') },
        { label: 'Grenade kills', value: numOf(dk, 'grenades') },
        { label: 'Vehicle kills', value: numOf(dk, 'vehicle') },
        { label: 'Passenger kills', value: numOf(dk, 'passenger') },
        { label: 'Melee kills', value: numOf(dk, 'melee') }
    ].filter((x) => toNum(x.value) > 0);

    if (!parts.length) return;

    node.appendChild(el('div', {
        class: 'bf-muted',
        text: 'Kill contexts, as a share of all ' + fmtInt(total) + ' career kills:'
    }));
    const max = parts.reduce((m, x) => Math.max(m, toNum(x.value)), 0);
    parts.sort((a, b) => toNum(b.value) - toNum(a.value)).forEach((x) => node.appendChild(barRow(
        x.label, x.value, max,
        fmtInt(x.value) + ' \u00b7 ' + (total > 0 ? ((toNum(x.value) / total) * 100).toFixed(1) : '0.0') + '%'
    )));
}

function renderTeamPlay(stats) {
    const node = $('bfTeamPlay');
    if (!node) return;
    const c = stats.core;
    renderSharePanel(node, [
        { label: 'Revives', value: c.revives },
        { label: 'Heals', value: c.heals },
        { label: 'Resupplies', value: c.resupplies },
        { label: 'Repairs', value: c.repairs },
        { label: 'Enemies spotted', value: c.enemiesSpotted },
        { label: 'Kill assists', value: c.killAssists }
    ], fmtInt);
}

function renderObjectivePlay(stats) {
    const node = $('bfObjective');
    if (!node) return;
    clear(node);

    const o = stats.objective || {};
    const time = o.time || {};
    const totalTime = numOf(time, 'total');

    const counts = [
        { label: 'Flags captured', value: numOf(o, 'captured') },
        { label: 'Flags neutralised', value: numOf(o, 'neutralized') },
        { label: 'Sectors captured', value: numOf(stats.sector, 'captured') },
        { label: 'Sectors armed', value: numOf(o, 'armed') }
    ].filter((x) => toNum(x.value) > 0);

    if (!counts.length && totalTime <= 0) {
        node.appendChild(el('div', { class: 'bf-muted', text: 'No objective actions recorded for this player yet.' }));
        return;
    }

    const max = counts.reduce((m, x) => Math.max(m, toNum(x.value)), 0);
    counts.sort((a, b) => toNum(b.value) - toNum(a.value)).forEach((x) =>
        node.appendChild(barRow(x.label, x.value, max, fmtInt(x.value))));

    if (totalTime > 0) {
        node.appendChild(el('div', {
            class: 'bf-muted',
            style: 'margin-top:10px;',
            text: 'Objective time: ' + fmtDuration(numOf(time, 'defended')) + ' defending, '
                + fmtDuration(numOf(time, 'attacked')) + ' attacking, out of '
                + fmtDuration(totalTime) + ' on objectives.'
        }));
    }
}

/* ------------------------------ DIAGRAMS ------------------------------- */

const CHART_COLORS = ['#818cf8', '#38bdf8', '#f59e0b', '#34d399', '#f472b6', '#a78bfa',
    '#fbbf24', '#60a5fa', '#f87171', '#4ade80', '#c084fc', '#2dd4bf'];

/* 3356382 -> "3.4M", 48210 -> "48k" — keeps donut centre text inside the ring. */
function fmtCompact(v) {
    const n = toNum(v);
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return fmtInt(n);
}

function svgText(x, y, text, cls, anchor) {
    const t = svgEl('text', { x: x, y: y, 'text-anchor': anchor || 'middle' });
    if (cls) t.setAttribute('class', cls);
    t.textContent = text;
    return t;
}

function svgTitle(node, text) {
    const t = svgEl('title');
    t.textContent = text;
    node.appendChild(t);
    return node;
}

/* Donut built from stroked circles + stroke-dasharray, which handles the
   100%-single-slice case gracefully (a plain arc path cannot). */
function renderDonut(svg, legendNode, rawSlices, centreValue, centreLabel) {
    clear(svg);
    clear(legendNode);

    const live = (rawSlices || [])
        .filter((s) => s && toNum(s.value) > 0)
        .sort((a, b) => toNum(b.value) - toNum(a.value));
    const total = live.reduce((s, x) => s + toNum(x.value), 0);

    if (!total) {
        legendNode.appendChild(el('div', { class: 'bf-muted', text: 'No data recorded for this player yet.' }));
        return;
    }

    svg.setAttribute('viewBox', '0 0 240 240');
    const cx = 120, cy = 120, r = 84, stroke = 34;
    const circumference = 2 * Math.PI * r;

    svg.appendChild(svgEl('circle', {
        cx: cx, cy: cy, r: r, fill: 'none', stroke: '#1b222d', 'stroke-width': stroke
    }));

    let acc = 0;
    live.forEach((s, i) => {
        const length = (toNum(s.value) / total) * circumference;
        svg.appendChild(svgEl('circle', {
            cx: cx, cy: cy, r: r,
            fill: 'none',
            stroke: s.color || CHART_COLORS[i % CHART_COLORS.length],
            'stroke-width': stroke,
            'stroke-dasharray': length.toFixed(3) + ' ' + (circumference - length).toFixed(3),
            'stroke-dashoffset': (-acc).toFixed(3),
            transform: 'rotate(-90 ' + cx + ' ' + cy + ')'
        }));
        acc += length;
    });

    svg.appendChild(svgText(120, 114, centreValue, 'bf-donut-value'));
    svg.appendChild(svgText(120, 136, centreLabel, 'bf-donut-label'));

    live.forEach((s, i) => {
        const color = s.color || CHART_COLORS[i % CHART_COLORS.length];
        legendNode.appendChild(el('div', { class: 'bf-legend-item' }, [
            el('span', { class: 'bf-legend-swatch', style: 'background:' + color }),
            el('span', { class: 'bf-legend-name', text: s.label }),
            el('span', { class: 'bf-legend-val', text: ((toNum(s.value) / total) * 100).toFixed(1) + '%' })
        ]));
    });
}

function renderXpDonut(stats) {
    const xp = stats.xp;
    if (!xp || !xp.total) {
        renderDonut($('bfXpDonutSvg'), $('bfXpDonutLegend'), [], '', '');
        return;
    }
    const performance = Math.max(0, toNum(xp.performance));
    const accolades = Math.max(0, toNum(xp.accolades));
    const other = Math.max(0, toNum(xp.total) - performance - accolades);

    renderDonut(
        $('bfXpDonutSvg'), $('bfXpDonutLegend'),
        [
            { label: 'Performance', value: performance, color: CHART_COLORS[0] },
            { label: 'Accolades', value: accolades, color: CHART_COLORS[2] },
            { label: 'Match & squad XP', value: other, color: CHART_COLORS[1] }
        ],
        fmtCompact(toNum(xp.total)),
        'total XP'
    );
}

function renderKillTypeDonut(stats) {
    const slices = KILL_LABELS.map((pair, i) => ({
        label: pair[1],
        value: numOf(stats.dividedKills, pair[0]),
        color: CHART_COLORS[i % CHART_COLORS.length]
    }));
    renderDonut(
        $('bfKillDonutSvg'), $('bfKillDonutLegend'), slices,
        fmtInt(stats.core.kills),
        'kills'
    );
}

/* ----------------------------- RADAR CHART ----------------------------- */

function clampScore(v, lo, hi) {
    const n = toNum(v);
    if (!isFinite(n)) return 0;
    if (hi === lo) return 0;
    return Math.max(0, Math.min(100, ((n - lo) / (hi - lo)) * 100));
}

/* Each axis gets its own realistic range so a 25% accuracy does not read as
   a 25% radar score against a 0-100 axis. Ranges are display heuristics. */
function radarAxes(stats) {
    const c = stats.core;
    const matches = Math.max(1, c.matchesPlayed);
    const objective = stats.objective || {};
    const objectiveSeconds = objective.time ? toNum(objective.time.total) : 0;

    return [
        { label: 'K/D', value: clampScore(c.killDeath, 0, 3), raw: fmtNum(c.killDeath) },
        { label: 'Kills/min', value: clampScore(c.killsPerMinute, 0, 4), raw: fmtNum(c.killsPerMinute) },
        { label: 'Damage/min', value: clampScore(c.damagePerMinute, 0, 800), raw: fmtInt(c.damagePerMinute) },
        { label: 'Accuracy', value: clampScore(c.accuracy, 0, 50), raw: fmtPct(c.accuracy) },
        { label: 'HS rate', value: clampScore(c.headshotPercent, 0, 70), raw: fmtPct(c.headshotPercent) },
        { label: 'Win rate', value: clampScore(c.winPercent, 0, 100), raw: fmtPct(c.winPercent) },
        { label: 'Revives/match', value: clampScore(c.revives / matches, 0, 3), raw: fmtNum(c.revives / matches) },
        { label: 'Obj time/match', value: clampScore(objectiveSeconds / matches, 0, 600), raw: fmtDuration(objectiveSeconds / matches) }
    ];
}

function renderRadar(stats) {
    const svg = $('bfRadarSvg');
    const legend = $('bfRadarLegend');
    clear(svg);
    clear(legend);

    const axes = radarAxes(stats);
    if (axes.length < 3) {
        legend.appendChild(el('div', { class: 'bf-muted', text: 'Not enough data to draw a profile.' }));
        return;
    }

    svg.setAttribute('viewBox', '0 0 320 260');
    const cx = 160, cy = 128, r = 84, n = axes.length;

    const ringPoints = (f) => {
        const pts = [];
        for (let i = 0; i < n; i++) {
            const ang = (i / n) * 2 * Math.PI - Math.PI / 2;
            pts.push((cx + r * f * Math.cos(ang)).toFixed(2) + ',' + (cy + r * f * Math.sin(ang)).toFixed(2));
        }
        return pts.join(' ');
    };

    [0.25, 0.5, 0.75, 1].forEach((f) => {
        svg.appendChild(svgEl('polygon', {
            points: ringPoints(f),
            fill: 'none',
            stroke: '#283548',
            'stroke-width': 1,
            opacity: f === 1 ? 0.95 : 0.45,
            'vector-effect': 'non-scaling-stroke'
        }));
    });

    axes.forEach((a, i) => {
        const ang = (i / n) * 2 * Math.PI - Math.PI / 2;
        const px = cx + r * Math.cos(ang);
        const py = cy + r * Math.sin(ang);
        svg.appendChild(svgEl('line', {
            x1: cx, y1: cy, x2: px.toFixed(2), y2: py.toFixed(2),
            stroke: '#283548', 'stroke-width': 1, opacity: 0.7,
            'vector-effect': 'non-scaling-stroke'
        }));

        const lx = cx + (r + 24) * Math.cos(ang);
        const ly = cy + (r + 24) * Math.sin(ang);
        const cos = Math.cos(ang);
        const anchor = Math.abs(cos) < 0.35 ? 'middle' : (cos > 0 ? 'start' : 'end');
        svg.appendChild(svgText(lx.toFixed(2), (ly + 3).toFixed(2), a.label, 'bf-axis-label', anchor));
    });

    const points = axes.map((a, i) => {
        const ang = (i / n) * 2 * Math.PI - Math.PI / 2;
        const rr = (r * Math.max(0, Math.min(100, a.value))) / 100;
        return { x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang), axis: a };
    });

    svg.appendChild(svgEl('polygon', {
        points: points.map((p) => p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' '),
        fill: 'rgba(129,140,248,0.30)',
        stroke: '#818cf8',
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke'
    }));

    points.forEach((p) => {
        const dot = svgEl('circle', {
            cx: p.x.toFixed(2), cy: p.y.toFixed(2), r: 3.2,
            fill: '#c7d2fe', stroke: '#4f46e5', 'stroke-width': 1
        });
        svgTitle(dot, p.axis.label + ': ' + p.axis.raw);
        svg.appendChild(dot);
    });

    axes.forEach((a) => {
        legend.appendChild(el('div', { class: 'bf-legend-item' }, [
            el('span', { class: 'bf-legend-name', text: a.label }),
            el('span', { class: 'bf-legend-val', text: a.raw })
        ]));
    });
}

/* --------------------------- WEAPON SCATTER ---------------------------- */

function renderWeaponScatter(stats) {
    const svg = $('bfWeaponScatter');
    const legend = $('bfWeaponScatterLegend');
    clear(svg);
    clear(legend);

    const live = (stats.weapons || []).filter((w) =>
        toNum(w.kills) > 0 && toNum(w.shotsFired) > 0 && toNum(w.accuracy) > 0);

    if (live.length < 2) {
        legend.appendChild(el('div', { class: 'bf-muted', text: 'Not enough weapon data to plot yet.' }));
        return;
    }

    const W = 340, H = 240, L = 48, R = 14, T = 16, B = 38;
    const plotW = W - L - R;
    const plotH = H - T - B;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    const maxX = Math.max(1, live.reduce((m, w) => Math.max(m, toNum(w.kills)), 0));
    const maxY = Math.max(1, live.reduce((m, w) => Math.max(m, toNum(w.accuracy)), 0));
    const maxShots = Math.max(1, live.reduce((m, w) => Math.max(m, toNum(w.shotsFired)), 0));

    const sx = (v) => L + (toNum(v) / maxX) * plotW;
    const sy = (v) => T + plotH - (toNum(v) / maxY) * plotH;

    [0.25, 0.5, 0.75, 1].forEach((f) => {
        const y = T + plotH - f * plotH;
        svg.appendChild(svgEl('line', {
            x1: L, y1: y.toFixed(2), x2: L + plotW, y2: y.toFixed(2),
            stroke: '#283548', 'stroke-width': 1, opacity: 0.5, 'vector-effect': 'non-scaling-stroke'
        }));
        svg.appendChild(svgText(L - 6, (y + 3).toFixed(2), fmtCompact(maxY * f), 'bf-axis-tick', 'end'));
    });

    [0.5, 1].forEach((f) => {
        const x = L + f * plotW;
        svg.appendChild(svgEl('line', {
            x1: x.toFixed(2), y1: T, x2: x.toFixed(2), y2: T + plotH,
            stroke: '#283548', 'stroke-width': 1, opacity: 0.5, 'vector-effect': 'non-scaling-stroke'
        }));
        svg.appendChild(svgText(x.toFixed(2), T + plotH + 16, fmtCompact(maxX * f), 'bf-axis-tick', 'middle'));
    });

    svg.appendChild(svgEl('line', {
        x1: L, y1: T + plotH, x2: L + plotW, y2: T + plotH,
        stroke: '#3b4a63', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke'
    }));
    svg.appendChild(svgEl('line', {
        x1: L, y1: T, x2: L, y2: T + plotH,
        stroke: '#3b4a63', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke'
    }));

    svg.appendChild(svgText(L + plotW / 2, H - 6, 'Kills', 'bf-axis-title', 'middle'));
    const yTitle = svgText(0, 0, 'Accuracy %', 'bf-axis-title', 'middle');
    yTitle.setAttribute('transform', 'translate(13,' + (T + plotH / 2) + ') rotate(-90)');
    svg.appendChild(yTitle);

    live.forEach((w) => {
        const radius = 3 + 7 * Math.sqrt(toNum(w.shotsFired) / maxShots);
        const dot = svgEl('circle', {
            cx: sx(w.kills).toFixed(2),
            cy: sy(w.accuracy).toFixed(2),
            r: radius.toFixed(2),
            fill: 'rgba(56,189,248,0.35)',
            stroke: '#38bdf8',
            'stroke-width': 1,
            'vector-effect': 'non-scaling-stroke'
        });
        svgTitle(dot, labelOf(w, 'weaponName') + ' — ' + fmtInt(w.kills) + ' kills · '
            + fmtPct(w.accuracy) + ' accuracy · ' + fmtInt(w.shotsFired) + ' shots');
        svg.appendChild(dot);
    });

    legend.appendChild(el('div', {
        class: 'bf-muted',
        text: live.length + ' weapons with kills, shots and accuracy recorded · bubble size = shots fired · hover a bubble for details'
    }));
}

/* -------------------------- TRACKED PROGRESS ---------------------------- */
/* Snapshots live in localStorage only. This is a static GitHub Pages site
   with no backend, so the trend starts at the first lookup and grows from
   there - it can never reconstruct matches from before that. */

const SNAPSHOT_KEY = 'bf6.snapshots.v1';
const SNAPSHOT_CAP = 60;

const TREND_METRICS = {
    kd: { label: 'K/D', format: (v) => fmtNum(v), delta: (v) => (v >= 0 ? '+' : '') + fmtNum(v) },
    accuracy: { label: 'Accuracy', format: (v) => fmtPct(v), delta: (v) => (v >= 0 ? '+' : '') + fmtNum(v, 1) + '%' },
    winPercent: { label: 'Win rate', format: (v) => fmtPct(v), delta: (v) => (v >= 0 ? '+' : '') + fmtNum(v, 1) + '%' },
    killsPerMinute: { label: 'Kills / min', format: (v) => fmtNum(v), delta: (v) => (v >= 0 ? '+' : '') + fmtNum(v) }
};

function readSnapshotStore() {
    try {
        const raw = window.localStorage.getItem(SNAPSHOT_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function writeSnapshotStore(store) {
    try {
        window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(store));
        return true;
    } catch (e) {
        return false;
    }
}

function snapshotKey(name, platform) {
    return String(platform || '') + '|' + String(name || '').toLowerCase();
}

function snapshotList(name, platform) {
    const list = readSnapshotStore()[snapshotKey(name, platform)];
    return Array.isArray(list) ? list.slice() : [];
}

function buildSnapshot(stats) {
    const c = stats.core;
    return {
        t: Date.now(),
        kills: c.kills,
        deaths: c.deaths,
        score: c.score,
        kd: c.killDeath,
        accuracy: c.accuracy,
        winPercent: c.winPercent,
        killsPerMinute: c.killsPerMinute,
        matchesPlayed: c.matchesPlayed,
        secondsPlayed: c.secondsPlayed,
        /* Cumulative counters are stored next to the ratios so two snapshots
           can be differenced into a real session (see sessionDeltas). A ratio
           like accuracy or winPercent cannot be subtracted - only the
           counters behind it can. */
        wins: c.wins,
        loses: c.loses,
        shotsFired: c.shotsFired,
        shotsHit: c.shotsHit,
        damage: c.damage
    };
}

function recordSnapshot(stats, platform) {
    const snap = buildSnapshot(stats);
    try {
        const store = readSnapshotStore();
        const key = snapshotKey(stats.player.name, platform);
        const list = Array.isArray(store[key]) ? store[key] : [];
        const last = list.length ? list[list.length - 1] : null;

        if (last && last.kills === snap.kills && last.deaths === snap.deaths && last.score === snap.score) {
            /* Unchanged numbers (reload / re-search): refresh the timestamp
               rather than inventing a new point of progress. */
            last.t = snap.t;
        } else {
            list.push(snap);
        }
        while (list.length > SNAPSHOT_CAP) list.shift();

        store[key] = list;
        writeSnapshotStore(store);
        return list;
    } catch (e) {
        return [snap];
    }
}

function clearSnapshots(name, platform) {
    try {
        const store = readSnapshotStore();
        delete store[snapshotKey(name, platform)];
        writeSnapshotStore(store);
    } catch (e) { /* ignore */ }
}

function shortDate(t) {
    const d = new Date(toNum(t));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function renderTrend(stats) {
    const svg = $('bfTrendSvg');
    const legend = $('bfTrendLegend');
    clear(svg);
    clear(legend);

    const metricKey = appState.trendMetric;
    const metric = TREND_METRICS[metricKey] || TREND_METRICS.kd;
    const name = stats.player.name;
    const platform = appState.platform;

    const points = snapshotList(name, platform)
        .map((p) => ({ t: toNum(p.t), v: toNum(p[metricKey]) }))
        .filter((p) => isFinite(p.t) && isFinite(p.v));

    const clearBtn = () => {
        const btn = el('button', { type: 'button', class: 'bf-link-btn', text: 'Clear my saved snapshots' });
        btn.addEventListener('click', () => {
            clearSnapshots(name, platform);
            renderTrend(stats);
        });
        return btn;
    };

    if (!points.length) {
        legend.appendChild(el('div', {
            class: 'bf-muted',
            text: 'No snapshots yet. One is saved automatically in this browser each time you load a player - come back after another session to start a trend.'
        }));
        legend.appendChild(clearBtn());
        return;
    }

    if (points.length === 1) {
        legend.appendChild(el('div', {
            class: 'bf-muted',
            text: 'First snapshot recorded ' + shortDate(points[0].t)
                + '. Tracking only covers sessions from your first visit onward and is stored in this browser alone - the API exposes no historical data to fill the gaps.'
        }));
        legend.appendChild(clearBtn());
        return;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const delta = last.v - first.v;

    legend.appendChild(el('span', { class: 'bf-legend-item' }, [
        el('i', { style: 'background:#818cf8' }),
        document.createTextNode(metric.label + ': ' + metric.format(first.v) + ' → '
            + metric.format(last.v) + ' (' + metric.delta(delta) + ')')
    ]));
    legend.appendChild(el('span', {
        text: points.length + ' snapshots since ' + shortDate(first.t)
            + ' · stored in this browser only, capped at ' + SNAPSHOT_CAP
    }));
    legend.appendChild(clearBtn());

    const W = 1000, H = 220;
    const padT = 16, padB = 30, padX = 14;
    const plotH = H - padT - padB;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    const times = points.map((p) => p.t);
    const tMin = Math.min.apply(null, times);
    const tMax = Math.max.apply(null, times);
    const span = tMax - tMin;

    let vMin = Math.min.apply(null, points.map((p) => p.v));
    let vMax = Math.max.apply(null, points.map((p) => p.v));
    if (vMax === vMin) {
        const pad = Math.abs(vMax) * 0.05 || 1;
        vMin -= pad;
        vMax += pad;
    } else {
        const pad = (vMax - vMin) * 0.15;
        vMin -= pad;
        vMax += pad;
    }

    const xFor = (t) => (span > 0 ? padX + ((t - tMin) / span) * (W - padX * 2) : W / 2);
    const yFor = (v) => padT + plotH * (1 - (v - vMin) / (vMax - vMin));

    for (let g = 0; g <= 4; g++) {
        const y = padT + (plotH * g) / 4;
        svg.appendChild(svgEl('line', {
            x1: 0, y1: y, x2: W, y2: y,
            stroke: '#283548', 'stroke-width': '1',
            'stroke-dasharray': g === 4 ? '' : '3 5',
            'vector-effect': 'non-scaling-stroke'
        }));
        svg.appendChild(svgEl('text', {
            x: 2, y: y - 3, fill: '#94a3b8', 'font-size': '11'
        })).textContent = metric.format(vMax + (vMin - vMax) * (g / 4));
    }

    const line = points.map((p) => xFor(p.t).toFixed(1) + ',' + yFor(p.v).toFixed(1));
    svg.appendChild(svgEl('path', {
        d: 'M ' + line.join(' L '),
        fill: 'none',
        stroke: '#818cf8',
        'stroke-width': '2.5',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        'vector-effect': 'non-scaling-stroke'
    }));

    points.forEach((p) => {
        const dot = svgEl('circle', {
            cx: xFor(p.t).toFixed(1), cy: yFor(p.v).toFixed(1), r: '3.4',
            fill: '#0b0f19', stroke: '#818cf8', 'stroke-width': '1.8',
            'vector-effect': 'non-scaling-stroke'
        });
        svgTitle(dot, shortDate(p.t) + ' · ' + metric.label + ' ' + metric.format(p.v));
        svg.appendChild(dot);
    });

    [0, points.length - 1].forEach((i, n) => {
        svg.appendChild(svgEl('text', {
            x: xFor(points[i].t).toFixed(1), y: H - 8,
            fill: '#94a3b8', 'font-size': '11',
            'text-anchor': n === 0 ? 'start' : 'end'
        })).textContent = shortDate(points[i].t);
    });
}

/* ----------------------------- SESSION LOG ------------------------------ */
/* There is no per-match data to fetch: /bf6/history/, /bf6/battlelog/ and
   /manager/sessions/ all 404 for BF6, so the API has no match list at all.
   Every figure it does return is a lifetime cumulative counter, though, so
   subtracting an earlier snapshot from a later one yields exactly what was
   played in between. That difference is the session - and its edges are when
   you pressed Search, not when the game thought a round ended. */

function sessionDeltas(list) {
    const rows = [];

    for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        const cur = list[i];

        /* Rows written before the counters were stored, or a profile that moved
           backwards (cleared, or a different account under the same name), make
           the subtraction meaningless rather than merely imprecise. */
        if (typeof prev.wins !== 'number' || typeof prev.shotsFired !== 'number') continue;

        const row = {
            from: toNum(prev.t),
            to: toNum(cur.t),
            matches: toNum(cur.matchesPlayed) - toNum(prev.matchesPlayed),
            kills: toNum(cur.kills) - toNum(prev.kills),
            deaths: toNum(cur.deaths) - toNum(prev.deaths),
            wins: toNum(cur.wins) - toNum(prev.wins),
            loses: toNum(cur.loses) - toNum(prev.loses),
            shotsFired: toNum(cur.shotsFired) - toNum(prev.shotsFired),
            shotsHit: toNum(cur.shotsHit) - toNum(prev.shotsHit),
            score: toNum(cur.score) - toNum(prev.score),
            seconds: toNum(cur.secondsPlayed) - toNum(prev.secondsPlayed),
            damage: toNum(cur.damage) - toNum(prev.damage)
        };

        if (row.kills < 0 || row.deaths < 0 || row.score < 0 || row.seconds < 0) continue;

        const moved = row.matches !== 0 || row.kills !== 0 || row.deaths !== 0
            || row.score !== 0 || row.seconds !== 0;
        if (!moved) continue;

        rows.push(row);
    }

    return rows;
}

function clockTime(t) {
    const d = new Date(toNum(t));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* "12 Sep 20:14 -> 12 Sep 22:40", with a real arrow. */
function sessionWindow(row) {
    return shortDate(row.from) + ' ' + clockTime(row.from)
        + ' \u2192 ' + shortDate(row.to) + ' ' + clockTime(row.to);
}

function fmtSigned(v, digits) {
    const n = toNum(v);
    if (!isFinite(n)) return '\u2014';
    return (n > 0 ? '+' : '') + fmtNum(n, typeof digits === 'number' ? digits : 0);
}

function renderSessionLog(stats) {
    const panel = $('bfSessionLogPanel');
    const head = $('bfSessionLogHead');
    const body = $('bfSessionLogBody');
    const summary = $('bfSessionLogSummary');
    const count = $('bfSessionLogCount');
    if (!panel || !head || !body) return;

    clear(head);
    clear(body);
    if (summary) clear(summary);

    const rows = sessionDeltas(snapshotList(stats.player.name, appState.platform));

    /* One check on its own is not a session - there has to be an earlier one to
       subtract from. Stay hidden rather than showing an empty table. */
    if (!rows.length) {
        panel.style.display = 'none';
        return;
    }

    ['Session', 'Window', 'Matches', 'W / L', 'Kills', 'Deaths', 'K/D', 'Accuracy', 'Score', 'Damage', 'Played']
        .forEach((label) => head.appendChild(el('th', { text: label })));

    /* Newest first, so the session you just finished is the top row. */
    rows.map((row, i) => ({ row: row, label: 'S' + (i + 1) })).reverse().forEach((entry) => {
        const row = entry.row;
        const kd = row.deaths > 0 ? row.kills / row.deaths : NaN;
        const acc = row.shotsFired > 0 ? (row.shotsHit / row.shotsFired) * 100 : NaN;
        const wl = (row.wins + row.loses) > 0 ? fmtInt(row.wins) + ' / ' + fmtInt(row.loses) : '\u2014';

        const cells = [
            entry.label,
            sessionWindow(row),
            fmtInt(row.matches),
            wl,
            fmtSigned(row.kills),
            fmtSigned(row.deaths),
            isFinite(kd) ? fmtNum(kd) : '\u2014',
            isFinite(acc) ? fmtPct(acc) : '\u2014',
            fmtSigned(row.score),
            fmtSigned(row.damage),
            fmtDuration(Math.max(0, row.seconds))
        ];

        body.appendChild(el('tr', null, cells.map((value, col) =>
            el('td', { class: col >= 2 ? 'num' : null, text: String(value) })
        )));
    });

    if (count) {
        count.textContent = rows.length + ' session' + (rows.length === 1 ? '' : 's')
            + ' \u00b7 this browser only';
    }

    if (summary) {
        const latest = rows[rows.length - 1];
        const kd = latest.deaths > 0 ? latest.kills / latest.deaths : NaN;
        const acc = latest.shotsFired > 0 ? (latest.shotsHit / latest.shotsFired) * 100 : NaN;

        const bits = [
            fmtInt(latest.matches) + ' match' + (latest.matches === 1 ? '' : 'es'),
            fmtSigned(latest.kills) + ' kills / ' + fmtSigned(latest.deaths) + ' deaths',
            isFinite(kd) ? 'K/D ' + fmtNum(kd) : null,
            (latest.wins + latest.loses) > 0 ? fmtSigned(latest.wins) + ' W / ' + fmtInt(latest.loses) + ' L' : null,
            isFinite(acc) ? fmtPct(acc) + ' accuracy' : null,
            fmtDuration(Math.max(0, latest.seconds)) + ' played'
        ].filter(Boolean);

        summary.appendChild(el('div', null, [
            el('strong', { text: 'Since your last check: ' }),
            document.createTextNode(bits.join(' \u00b7 '))
        ]));
        summary.appendChild(el('div', {
            class: 'bf-muted',
            text: 'Each row is everything played between two checks of this page, not individual matches. '
                + 'The API keeps no match history, so nothing from before your first visit can be recovered.'
        }));
    }

    panel.style.display = '';
}
/* --------------------- SESSION HISTORY (/manager/sessions) --------------- */
/* Best effort: only populated for players who played on gametools-managed   */
/* community servers. When empty the whole panel stays hidden.               */

const LEGACY_PLATFORM = {
    steam: 'pc',
    ea: 'pc',
    pc: 'pc',
    epic: 'pc',
    ps5: 'ps4',
    ps4: 'ps4',
    psn: 'ps4',
    xboxseries: 'xboxone',
    xboxone: 'xboxone',
    xbox: 'xboxone',
    xbl: 'xboxone'
};

function hideSessions() {
    const panel = $('bfSessionsPanel');
    if (panel) panel.style.display = 'none';
}

function fmtStamp(ts) {
    const n = toNum(ts);
    if (!n) return null;
    const d = new Date(n > 1e12 ? n : n * 1000);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString();
}

function renderSessions(rows) {
    const panel = $('bfSessionsPanel');
    if (!panel) return;

    const ordered = rows.slice().sort((a, b) => toNum(b.timeStamp) - toNum(a.timeStamp));
    const head = $('bfSessionsHead');
    const body = $('bfSessionsBody');
    clear(head);
    clear(body);

    ['When', 'Server', 'Kills', 'Deaths', 'K/D', 'W / L', 'Score', 'Time', 'Modes'].forEach((label) => {
        head.appendChild(el('th', { text: label }));
    });

    ordered.forEach((row) => {
        const st = row.stats || {};
        const kills = toNum(st.kills);
        const deaths = toNum(st.deaths);
        const wins = toNum(st.wins);
        const losses = toNum(st.losses);
        const modes = Array.isArray(st.gamemodes) ? st.gamemodes : [];

        const when = fmtStamp(row.timeStamp);
        const cells = [
            when || 'unknown',
            row.serverName || row.serverId || 'Unknown server',
            isFinite(kills) ? fmtInt(kills) : '—',
            isFinite(deaths) ? fmtInt(deaths) : '—',
            deaths > 0 ? (kills / deaths).toFixed(2) : (kills > 0 ? kills.toFixed(2) : '—'),
            (wins + losses) ? (fmtInt(wins) + ' / ' + fmtInt(losses)) : '—',
            isFinite(toNum(st.score)) ? fmtInt(toNum(st.score)) : '—',
            isFinite(toNum(st.timePlayed)) ? fmtInt(toNum(st.timePlayed)) : '—',
            modes.length ? modes.join(', ') : '—'
        ];

        body.appendChild(el('tr', null, cells.map((value) => el('td', { text: String(value) }))));
    });

    $('bfSessionsCount').textContent = ordered.length + ' rounds · gametools-managed servers only';
    panel.style.display = '';
}

async function loadSessions(name, platform) {
    hideSessions();

    const legacy = LEGACY_PLATFORM[String(platform || '').toLowerCase()];
    if (!legacy) return;

    try {
        const data = await apiGet('/manager/sessions/', {
            name: name,
            platform: legacy
        });
        const rows = Array.isArray(data.data) ? data.data : [];
        if (!rows.length) return;
        renderSessions(rows);
    } catch (err) {
        /* Absence is the expected case — never surface an error for this panel. */
        console.info('No session history for', name, '(', err && err.status, ')');
    }
}

/* ------------------------- LOADING / STATUS UI ------------------------- */

function setStatus(kind, title, hint) {
    const node = $('bfStatus');
    clear(node);
    if (!kind) return;
    node.appendChild(el('div', { class: 'bf-status ' + kind }, [
        el('strong', { text: title }),
        hint ? el('span', { class: 'bf-status-hint', text: hint }) : null
    ]));
}

function setLoading(on, label) {
    const skeleton = $('bfSkeleton');
    const btn = $('bfSubmitBtn');
    if (btn) {
        clear(btn);
        if (on) {
            btn.appendChild(el('span', { class: 'bf-spinner' }));
            btn.appendChild(document.createTextNode(label || 'Loading'));
            btn.disabled = true;
        } else {
            btn.textContent = 'Search';
            btn.disabled = false;
        }
    }
    if (!skeleton) return;
    clear(skeleton);
    skeleton.style.display = on ? 'grid' : 'none';
    if (on) {
        for (let i = 0; i < 8; i++) skeleton.appendChild(el('div', { class: 'bf-skeleton-item' }));
    }
}

/* --------------------------- RECENT SEARCHES --------------------------- */

function readRecent() {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

function pushRecent(name, platform) {
    const list = readRecent().filter((r) => !(r.name === name && r.platform === platform));
    list.unshift({ name: name, platform: platform });
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (e) { /* ignore */ }
    renderRecent();
}

function renderRecent() {
    const wrap = $('bfRecent');
    const list = readRecent();
    clear(wrap);
    if (!list.length) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'flex';
    wrap.appendChild(el('span', { class: 'bf-recent-label', text: 'Recent:' }));
    list.forEach((r) => {
        const b = el('button', { type: 'button', text: r.name + ' (' + r.platform + ')' });
        b.addEventListener('click', () => {
            $('bfNameInput').value = r.name;
            $('bfPlatformSelect').value = r.platform;
            loadPlayer(r.name, r.platform);
        });
        wrap.appendChild(b);
    });
}

/* --------------------------- SAVED SHORTCUTS --------------------------- */

function readSaved() {
    try {
        const raw = localStorage.getItem(SAVED_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((s) => s && s.name) : [];
    } catch (e) {
        return [];
    }
}

/* The API is case-sensitive, but saving "Offroad89" and "offroad89" as two
   separate shortcuts is user error worth absorbing. Store the typed casing. */
function savedIndex(name, platform) {
    return String(platform || '') + '|' + String(name || '').toLowerCase();
}

function isSaved(name, platform) {
    const key = savedIndex(name, platform);
    return readSaved().some((s) => savedIndex(s.name, s.platform) === key);
}

function writeSaved(list) {
    try {
        localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, SAVED_MAX)));
    } catch (e) { /* ignore: shortcuts are a nice-to-have, never required */ }
}

function toggleSaved(name, platform) {
    const key = savedIndex(name, platform);
    const list = readSaved();
    const at = list.findIndex((s) => savedIndex(s.name, s.platform) === key);

    if (at === -1) list.unshift({ name: name, platform: platform });
    else list.splice(at, 1);

    writeSaved(list);
    renderSaved();
}

function removeSaved(name, platform) {
    const key = savedIndex(name, platform);
    writeSaved(readSaved().filter((s) => savedIndex(s.name, s.platform) !== key));
    renderSaved();
}

function syncSaveButton() {
    const btn = $('bfSaveBtn');
    if (!btn) return;
    const input = $('bfNameInput');
    const sel = $('bfPlatformSelect');
    const name = input ? input.value.trim() : '';
    const saved = name ? isSaved(name, sel ? sel.value : '') : false;

    btn.textContent = saved ? '★ Saved' : 'Save';
    btn.classList.toggle('active', saved);
    btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
}

function loadShortcut(name, platform) {
    const input = $('bfNameInput');
    const sel = $('bfPlatformSelect');
    if (input) input.value = name;
    if (sel) sel.value = platform;
    syncSaveButton();
    loadPlayer(name, platform);
}

function renderSaved() {
    const wrap = $('bfSaved');
    if (!wrap) return;
    const list = readSaved();
    clear(wrap);

    if (!list.length) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'flex';
    wrap.appendChild(el('span', { class: 'bf-recent-label', text: 'Saved:' }));

    list.forEach((s) => {
        const holder = el('span', { class: 'bf-chip-wrap' });

        const open = el('button', { type: 'button', class: 'bf-chip-main', text: s.name + ' (' + s.platform + ')' });
        open.addEventListener('click', () => loadShortcut(s.name, s.platform));

        const drop = el('button', {
            type: 'button',
            class: 'bf-chip-x',
            title: 'Remove ' + s.name + ' from shortcuts',
            text: '×'
        });
        drop.addEventListener('click', () => {
            removeSaved(s.name, s.platform);
            syncSaveButton();
        });

        holder.appendChild(open);
        holder.appendChild(drop);
        wrap.appendChild(holder);
    });
}

/* ------------------------------ CONTROLLER ----------------------------- */

const appState = {
    name: '',
    platform: '',
    seasonLabel: '',
    activityDays: 7,
    trendMetric: 'kd',
    hasLoaded: false,
    lastStats: null,
    lastProfile: null,
    lastQuery: null
};

function updateUrl(name, platform) {
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('name', name);
        url.searchParams.set('platform', platform);
        window.history.replaceState(null, '', url.toString());
    } catch (e) { /* non-fatal */ }
}

function readUrl() {
    try {
        const p = new URLSearchParams(window.location.search);
        const name = p.get('name');
        if (name) return { name: name, platform: p.get('platform') || DEFAULT_PLAYER.platform };
    } catch (e) { /* ignore */ }
    return null;
}

function populatePlatforms() {
    const sel = $('bfPlatformSelect');
    clear(sel);
    PLATFORMS.forEach((pair) => sel.appendChild(el('option', { value: pair[0], text: pair[1] })));
}

function ensurePlatformOption(platform) {
    const sel = $('bfPlatformSelect');
    if (!platform) return;
    const exists = Array.prototype.some.call(sel.options, (o) => o.value === platform);
    if (!exists) sel.appendChild(el('option', { value: platform, text: platform }));
    sel.value = platform;
}

/* ------------------------------- LOADERS ------------------------------- */

async function loadPlayer(name, platform) {
    setStatus(null);
    setLoading(true, 'Loading');

    try {
        /* The profile endpoint is a bonus: if it 404s the main stats must
           still render, so its failure resolves to null instead of throwing. */
        const profileRequest = apiGet('/bf6/profile/', { name: name, platform: platform })
            .catch((err) => {
                console.info('Profile panel unavailable:', err && err.status);
                return null;
            });

        const raw = await apiGet('/bf6/stats/', {
            name: name,
            platform: platform,
            seperation: true
        });

        const stats = normaliseStats(raw);
        if (!stats.player.name) throw ApiError('Player not found', 'notfound', 404);

        const profile = normaliseProfile(await profileRequest);

        appState.name = stats.player.name;
        appState.platform = platform;
        appState.lastStats = stats;
        appState.lastProfile = profile;
        appState.lastQuery = { name: name, platform: platform };
        appState.hasLoaded = true;

        renderIdentity(stats, appState.lastQuery);
        syncSaveButton();
        renderOverview(stats);
        renderCareer(stats);
        renderHighlights(profile);
        renderDamageBreakdown(stats);
        renderRadar(stats);
        renderXpDonut(stats);
        renderKillTypeDonut(stats);
        renderClassTime(profile);
        renderModeTime(profile);
        renderWeaponClassKills(profile);
        renderModeCompare(stats);
        renderWeaponScatter(stats);
        renderMapPerformance(stats);
        renderAimStyle(stats);
        renderTeamPlay(stats);
        renderObjectivePlay(stats);
        recordSnapshot(stats, platform);
        renderTrend(stats);
        renderSessionLog(stats);
        renderWeapons(stats);
        renderWeaponGroups(stats);
        renderClasses(stats);
        renderGameModes(stats);
        renderMaps(stats);
        renderVehicles(stats);
        renderGadgets(stats);
        renderMelee(stats);
        loadSessions(stats.player.name, platform);

        const modeLabel = $('bfCareerMode');
        if (modeLabel) modeLabel.textContent = 'multiplayer · all seasons';

        $('bfResults').style.display = 'block';
        pushRecent(name, platform);
        updateUrl(name, platform);
    } catch (err) {
        const info = describeError(err);
        setStatus('error', info.title, info.hint);
        /* Keep already-rendered stats on screen so a typo does not wipe the page. */
        if (!appState.hasLoaded) $('bfResults').style.display = 'none';
        console.error('BF6 stats lookup failed:', err);
    } finally {
        setLoading(false);
    }
}

async function loadSeason() {
    try {
        const data = await apiGet('/bf6/gameevents/', {});
        const events = Array.isArray(data.events) ? data.events : [];
        const season = events.find((e) => /^season/i.test(String(e.name)) && e.active)
            || events.find((e) => /^season/i.test(String(e.name)));
        const pass = events.find((e) => e.battlePass && e.active);

        let label = '';
        if (season) label = String(season.name).replace(/^season\s*(\d+)$/i, 'Season $1');
        if (pass) label += (label ? ' · ' : '') + String(pass.name);

        appState.seasonLabel = label;

        /* Refresh the identity chips when stats are already on screen. */
        if (appState.lastStats) renderIdentity(appState.lastStats, appState.lastQuery);
    } catch (err) {
        console.warn('Season info unavailable:', err);
    }
}

async function loadActivity(days) {
    appState.activityDays = days;
    const legend = $('bfActivityLegend');
    clear(legend);
    legend.appendChild(el('span', { text: 'Loading activity…' }));

    try {
        const data = await apiGet('/bf6/statusarray/', { days: days, region: 'all', type: 'amounts' });
        renderActivityChart(data);
    } catch (err) {
        clear($('bfActivitySvg'));
        clear(legend);
        legend.appendChild(el('span', { text: 'Activity data is unavailable right now.' }));
        console.warn('Activity chart failed:', err);
    }
}

/* -------------------------------- INIT --------------------------------- */

function wireActivityToggle() {
    const group = $('bfActivityRange');
    if (!group) return;
    Array.prototype.forEach.call(group.querySelectorAll('button'), (btn) => {
        btn.addEventListener('click', () => {
            Array.prototype.forEach.call(group.querySelectorAll('button'), (b) => b.classList.remove('active'));
            btn.classList.add('active');
            loadActivity(parseInt(btn.dataset.days, 10) || 7);
        });
    });
}

function wireTrendToggle() {
    const group = $('bfTrendMetric');
    if (!group) return;
    Array.prototype.forEach.call(group.querySelectorAll('button'), (btn) => {
        btn.addEventListener('click', () => {
            Array.prototype.forEach.call(group.querySelectorAll('button'), (b) => b.classList.remove('active'));
            btn.classList.add('active');
            appState.trendMetric = btn.dataset.metric || 'kd';
            if (appState.lastStats) renderTrend(appState.lastStats);
        });
    });
}

function init() {
    populatePlatforms();
    wireActivityToggle();
    wireTrendToggle();

    $('bfSearchForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const name = $('bfNameInput').value.trim();
        if (!name) return;
        loadPlayer(name, $('bfPlatformSelect').value);
    });

    /* Shortcuts act on whatever is typed right now, so no lookup is required. */
    $('bfSaveBtn').addEventListener('click', () => {
        const name = $('bfNameInput').value.trim();
        if (!name) return;
        toggleSaved(name, $('bfPlatformSelect').value);
        syncSaveButton();
    });
    $('bfNameInput').addEventListener('input', syncSaveButton);
    $('bfPlatformSelect').addEventListener('change', syncSaveButton);

    renderRecent();
    renderSaved();

    /* Player-independent live panels load alongside the first lookup. */
    loadSeason();
    loadActivity(appState.activityDays);

    const query = readUrl() || DEFAULT_PLAYER;
    $('bfNameInput').value = query.name;
    ensurePlatformOption(query.platform);
    syncSaveButton();
    loadPlayer(query.name, query.platform);
}

init();












