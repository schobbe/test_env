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

async function throttle() {
    const wait = THROTTLE_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
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

function renderKillBreakdown(stats) {
    renderBarPanel($('bfKillBreakdown'), collectBreakdown(stats.dividedKills, KILL_LABELS));
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

/* --------------------------- SERVER BROWSER ---------------------------- */

function renderServerFilters(regions) {
    const wrap = $('bfServerFilters');
    clear(wrap);
    regions.forEach((region) => {
        const chip = el('button', {
            type: 'button',
            class: 'bf-filter-chip' + (appState.serverRegion === region ? ' active' : ''),
            text: region === 'all' ? 'All regions' : region
        });
        chip.addEventListener('click', () => {
            appState.serverRegion = region;
            renderServerFilters(regions);
            renderServerList();
        });
        wrap.appendChild(chip);
    });
}

function renderServerList() {
    const list = $('bfServerList');
    clear(list);

    const all = appState.servers;
    const filtered = appState.serverRegion === 'all'
        ? all
        : all.filter((s) => String(s.region || '') === appState.serverRegion);

    if (!filtered.length) {
        list.appendChild(el('div', { class: 'bf-muted', text: 'No portal servers found for this region right now.' }));
        return;
    }

    const ordered = filtered.slice().sort((a, b) => toNum(b.playerAmount) - toNum(a.playerAmount));

    ordered.slice(0, 40).forEach((s) => {
        const players = toNum(s.playerAmount);
        const max = Math.max(1, toNum(s.maxPlayers));
        const fill = Math.max(0, Math.min(100, (players / max) * 100));

        list.appendChild(el('div', { class: 'bf-server-card' }, [
            el('div', { class: 'bf-server-name', text: s.prefix || 'Unnamed server' }),
            el('div', { class: 'bf-server-meta' }, [
                el('span', { text: s.region || 'unknown region' }),
                el('span', { text: s.mode || 'mode n/a' }),
                el('span', { text: s.currentMap || 'map n/a' }),
                el('span', { text: (s.owner && s.owner.platform) ? s.owner.platform : 'platform n/a' })
            ]),
            el('div', { class: 'bf-server-players' }, [
                el('div', { class: 'bf-bar-track', style: 'flex:1' }, [
                    el('div', { class: 'bf-bar-fill', style: 'width:' + fill.toFixed(1) + '%' })
                ]),
                el('span', { class: 'bf-muted', text: players + '/' + max })
            ])
        ]));
    });

    if (ordered.length > 40) {
        list.appendChild(el('div', {
            class: 'bf-muted',
            text: 'Showing the 40 busiest of ' + ordered.length + ' servers in this region.'
        }));
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

/* ------------------------------ CONTROLLER ----------------------------- */

const appState = {
    name: '',
    platform: '',
    seasonLabel: '',
    activityDays: 7,
    servers: [],
    serverRegion: 'all',
    hasLoaded: false,
    lastStats: null,
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
        const raw = await apiGet('/bf6/stats/', {
            name: name,
            platform: platform,
            seperation: true
        });

        const stats = normaliseStats(raw);
        if (!stats.player.name) throw ApiError('Player not found', 'notfound', 404);

        appState.name = stats.player.name;
        appState.platform = platform;
        appState.lastStats = stats;
        appState.lastQuery = { name: name, platform: platform };
        appState.hasLoaded = true;

        renderIdentity(stats, appState.lastQuery);
        renderOverview(stats);
        renderCareer(stats);
        renderKillBreakdown(stats);
        renderDamageBreakdown(stats);
        renderWeapons(stats);
        renderWeaponGroups(stats);
        renderClasses(stats);
        renderGameModes(stats);
        renderMaps(stats);
        renderVehicles(stats);
        renderGadgets(stats);
        renderMelee(stats);

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

async function loadServers() {
    const list = $('bfServerList');
    try {
        const data = await apiGet('/bf6/servers/', { region: 'all' });
        appState.servers = Array.isArray(data.servers) ? data.servers : [];

        const unique = [];
        appState.servers.forEach((s) => {
            if (s.region && unique.indexOf(s.region) === -1) unique.push(s.region);
        });
        unique.sort();

        renderServerFilters(['all'].concat(unique));
        renderServerList();
    } catch (err) {
        clear(list);
        list.appendChild(el('div', { class: 'bf-muted', text: 'Server list is unavailable right now.' }));
        console.warn('Server list failed:', err);
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

function init() {
    populatePlatforms();
    wireActivityToggle();

    $('bfSearchForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const name = $('bfNameInput').value.trim();
        if (!name) return;
        loadPlayer(name, $('bfPlatformSelect').value);
    });

    renderRecent();

    /* Player-independent live panels load alongside the first lookup. */
    loadSeason();
    loadActivity(appState.activityDays);
    loadServers();

    const query = readUrl() || DEFAULT_PLAYER;
    $('bfNameInput').value = query.name;
    ensurePlatformOption(query.platform);
    loadPlayer(query.name, query.platform);
}

init();












