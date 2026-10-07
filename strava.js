/* =========================================================================
   Ride Analytics
   Cycling analysis of a Strava "Download your archive" export.

   Design notes:
   - No backend, no API and no third-party JavaScript. Files are read with the
     File API, the ZIP is walked by hand and inflated with the browser's own
     DecompressionStream, and Garmin .fit files are decoded by the small FIT
     reader below. Nothing leaves the browser.
   - The export is read ONCE. Each ride is reduced to a summary plus per-sample
     streams and kept in IndexedDB, so the later views never touch files again.
   - Cycling only for now: the FIT sport field decides, with the CSV activity
     type as a fallback for files that do not say.
   - activities.csv is localised by Strava for non-English accounts, so its
     columns are found by position with header names only as a hint, and
     anything measurable comes from the FIT file, never from the CSV.
   ========================================================================= */

/* ------------------------------- CONFIG -------------------------------- */

const DB_NAME = 'ride-analytics';
const DB_VERSION = 1;

/* Bump when the summary rules change: stored rides older than this are
   flagged so the user knows a re-import gives different numbers. */
const PARSER_VERSION = 2;    /* 2: power figures use cleaned power */

const SETTINGS_KEY = 'rides.settings.v1';

const DEFAULT_WINDOW_DAYS = 90;
const WINDOW_MIN_DAYS = 7;
const WINDOW_MAX_DAYS = 730;

/* Gaps longer than this between two records are a pause (auto-pause, or the
   timer stopped); shorter ones are Garmin "smart recording" and are filled. */
const MAX_GAP_S = 10;

const MOVING_SPEED_MS = 0.5;
const ASCENT_HYSTERESIS_M = 2;
const NP_WINDOW_S = 30;

const LIST_PAGE = 50;

/* Power cleaning - see cleanPower. */
const SPIKE_RATIO = 2;
const SPIKE_MIN_JUMP_W = 300;
const POWER_CAP_W = 2500;

const BEST_EFFORT_S = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
const DECOUPLING_MIN_S = 20 * 60;

/* Zones as lower bounds, as a fraction of the reference. */
const POWER_ZONE_LOWS = [0, 0.56, 0.76, 0.91, 1.06, 1.21, 1.51];      /* Coggan, x FTP */
const POWER_ZONE_NAMES = ['Active recovery', 'Endurance', 'Tempo', 'Threshold', 'VO2max', 'Anaerobic', 'Neuromuscular'];
const HR_ZONE_LOWS = [0, 0.81, 0.90, 0.94, 1.00, 1.03, 1.07];         /* Friel, x threshold HR */
const HR_ZONE_NAMES = ['Recovery', 'Aerobic', 'Tempo', 'Sub-threshold', 'Super-threshold', 'Aerobic capacity', 'Anaerobic'];
const HR_MAX_ZONE_LOWS = [0, 0.60, 0.70, 0.80, 0.90];                 /* x max HR */
const HR_MAX_ZONE_NAMES = ['Very light', 'Light', 'Moderate', 'Hard', 'Maximum'];
const ZONE_COLORS = ['#64748b', '#38bdf8', '#34d399', '#facc15', '#fb923c', '#f87171', '#c084fc'];

/* Chart channels, in display order. */
const CHANNELS = [
    { key: 'power', label: 'Power', unit: 'W', color: '#f59e0b', zero: true, digits: 0 },
    { key: 'hr', label: 'Heart rate', unit: 'bpm', color: '#f87171', digits: 0 },
    { key: 'speed', label: 'Speed', unit: 'km/h', color: '#38bdf8', zero: true, digits: 1, scale: 3.6 },
    { key: 'cadence', label: 'Cadence', unit: 'rpm', color: '#34d399', zero: true, digits: 0 },
    { key: 'altitude', label: 'Elevation', unit: 'm', color: '#94a3b8', area: true, digits: 0 }
];

const FIT_EPOCH_S = 631065600;          /* 1989-12-31T00:00:00Z */
const SEMICIRCLE_DEG = 180 / 2 ** 31;

const FIT_SPORT_CYCLING = 2;
const CSV_CYCLING_TYPE = /ride|bike|cycl|velomobile|handcycle|rad/i;

/* FIT sub_sport values seen on bikes, for a readable type when there is no
   CSV row to take Strava's own label from. */
const FIT_SUB_SPORT = {
    6: 'Indoor ride',
    7: 'Road ride',
    8: 'Mountain bike ride',
    11: 'Cyclocross ride',
    13: 'Track ride',
    46: 'Gravel ride',
    58: 'Virtual ride'
};

const FIT_MANUFACTURER = { 1: 'Garmin', 32: 'Wahoo', 89: 'Tacx', 260: 'Zwift', 265: 'Hammerhead' };

/* ------------------------------ HELPERS -------------------------------- */

const $ = (id) => document.getElementById(id);

function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? '' : v);
        }
    }
    for (const c of [].concat(children || [])) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function fmtInt(v) { return isNum(v) ? Math.round(v).toLocaleString('en-US') : '–'; }
function fmtKm(m) { return isNum(m) ? (m / 1000).toFixed(1) : '–'; }

function fmtDuration(sec) {
    if (!isNum(sec)) return '–';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

/* Rides are shown in the local time of wherever they were ridden: the FIT
   activity message carries that offset, so no browser time zone is involved. */
function localDate(ride) {
    return new Date((ride.startUnix + (ride.tzOffsetSec || 0)) * 1000);
}

function fmtDate(ride) {
    return localDate(ride).toISOString().slice(0, 10);
}

function fmtDateTime(ride) {
    const iso = localDate(ride).toISOString();
    return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
}

function basename(path) {
    return String(path).replace(/\\/g, '/').split('/').pop().toLowerCase();
}

/* ----------------------------- FIT DECODER ----------------------------- */

class FitError extends Error {}

const FIT_CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
                       0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];

function fitCrc(bytes, from, to) {
    let crc = 0;
    for (let i = from; i < to; i++) {
        const b = bytes[i];
        let tmp = FIT_CRC_TABLE[crc & 0xF];
        crc = (crc >> 4) & 0x0FFF;
        crc = crc ^ tmp ^ FIT_CRC_TABLE[b & 0xF];
        tmp = FIT_CRC_TABLE[crc & 0xF];
        crc = (crc >> 4) & 0x0FFF;
        crc = crc ^ tmp ^ FIT_CRC_TABLE[(b >> 4) & 0xF];
    }
    return crc;
}

/* Size in bytes of each FIT base type, indexed by its low five bits. Files
   disagree on whether the endian-ability bit (0x80) is set, so only the low
   bits are trusted. */
const FIT_BASE_SIZE = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];

/* Reads one scalar; the type's "invalid" sentinel becomes null. */
function fitScalar(view, off, base, le) {
    let v;
    switch (base) {
        case 0: case 2: case 13: v = view.getUint8(off); return v === 0xFF ? null : v;
        case 10: v = view.getUint8(off); return v === 0 ? null : v;
        case 1: v = view.getInt8(off); return v === 0x7F ? null : v;
        case 3: v = view.getInt16(off, le); return v === 0x7FFF ? null : v;
        case 4: v = view.getUint16(off, le); return v === 0xFFFF ? null : v;
        case 11: v = view.getUint16(off, le); return v === 0 ? null : v;
        case 5: v = view.getInt32(off, le); return v === 0x7FFFFFFF ? null : v;
        case 6: v = view.getUint32(off, le); return v === 0xFFFFFFFF ? null : v;
        case 12: v = view.getUint32(off, le); return v === 0 ? null : v;
        case 8: v = view.getFloat32(off, le); return Number.isFinite(v) ? v : null;
        case 9: v = view.getFloat64(off, le); return Number.isFinite(v) ? v : null;
        default: return null;   /* 64-bit integers: nothing we read uses them */
    }
}

const utf8 = new TextDecoder('utf-8');

function fitField(view, off, f, le) {
    if (f.base === 7) {
        const bytes = new Uint8Array(view.buffer, view.byteOffset + off, f.size);
        const nul = bytes.indexOf(0);
        const s = utf8.decode(nul === -1 ? bytes : bytes.subarray(0, nul));
        return s || null;
    }
    /* Arrays (size a multiple of the base size) and malformed sizes are
       skipped: none of the fields we use is an array. */
    if (f.size !== FIT_BASE_SIZE[f.base]) return null;
    return fitScalar(view, off, f.base, le);
}

/* Global message numbers that are decoded; everything else is skipped by
   size, which is what keeps 500 files fast. */
const FIT_WANTED = new Set([0, 3, 7, 12, 18, 20, 21, 34]);

function parseFit(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const out = {
        fileId: null, userProfile: null, zonesTarget: null, sport: null, activity: null,
        sessions: [], records: [], events: [], warnings: []
    };

    let pos = 0;
    let files = 0;
    /* Chained FIT files are just several complete files back to back. */
    while (pos + 12 <= bytes.length) {
        const headerSize = bytes[pos];
        const sig = String.fromCharCode(bytes[pos + 8], bytes[pos + 9], bytes[pos + 10], bytes[pos + 11]);
        if ((headerSize !== 12 && headerSize !== 14) || sig !== '.FIT') {
            if (files > 0) break;   /* trailing padding after a valid file */
            throw new FitError('Not a FIT file.');
        }
        const dataSize = view.getUint32(pos + 4, true);
        const start = pos + headerSize;
        const end = start + dataSize;
        if (end > bytes.length) {
            throw new FitError('FIT file is truncated: ' + (bytes.length - start) +
                ' of ' + dataSize + ' data bytes present.');
        }
        if (end + 2 <= bytes.length) {
            const stored = view.getUint16(end, true);
            if (stored !== 0 && fitCrc(bytes, pos, end) !== stored) {
                out.warnings.push('CRC mismatch - the file may be damaged.');
            }
        } else {
            out.warnings.push('File CRC missing.');
        }
        fitMessages(view, start, end, out);
        files++;
        pos = end + 2;
    }
    if (!files) throw new FitError('Not a FIT file.');
    return out;
}

function fitMessages(view, start, end, out) {
    const defs = [];
    let lastTs = null;
    let p = start;

    while (p < end) {
        const h = view.getUint8(p++);
        let local;
        let compressedTs = null;

        if (h & 0x80) {
            /* Compressed timestamp: 5-bit offset against the last full one. */
            local = (h >> 5) & 0x03;
            if (lastTs === null) throw new FitError('Compressed timestamp before any full timestamp.');
            const offset = h & 0x1F;
            const low = lastTs % 32;
            compressedTs = lastTs - low + offset + (offset < low ? 32 : 0);
            lastTs = compressedTs;
        } else if (h & 0x40) {
            local = h & 0x0F;
            if (p + 5 > end) throw new FitError('FIT file is truncated inside a definition.');
            const le = view.getUint8(p + 1) === 0;
            const global = view.getUint16(p + 2, le);
            const count = view.getUint8(p + 4);
            p += 5;
            const fields = [];
            let size = 0;
            let tsOff = -1;
            for (let i = 0; i < count; i++) {
                const num = view.getUint8(p);
                const fsize = view.getUint8(p + 1);
                const base = view.getUint8(p + 2) & 0x1F;
                if (num === 253 && fsize === 4) tsOff = size;
                fields.push({ num, size: fsize, base, off: size });
                size += fsize;
                p += 3;
            }
            if (h & 0x20) {
                const devCount = view.getUint8(p++);
                for (let i = 0; i < devCount; i++) {
                    size += view.getUint8(p + 1);
                    p += 3;
                }
            }
            defs[local] = { global, le, fields, size, tsOff, wanted: FIT_WANTED.has(global) };
            continue;
        } else {
            local = h & 0x0F;
        }

        const def = defs[local];
        if (!def) throw new FitError('Data message for undefined local type ' + local + '.');
        if (p + def.size > end) throw new FitError('FIT file is truncated inside a data message.');

        if (def.tsOff >= 0) {
            const ts = fitScalar(view, p + def.tsOff, 6, def.le);
            if (ts !== null) lastTs = ts;
        }
        if (def.wanted) {
            const m = {};
            for (const f of def.fields) m[f.num] = fitField(view, p + f.off, f, def.le);
            if (compressedTs !== null) m[253] = compressedTs;
            fitDispatch(def.global, m, out);
        }
        p += def.size;
    }
}

const scaled = (v, scale, offset) => (v === null || v === undefined ? null : v / scale - (offset || 0));

function fitDispatch(global, m, out) {
    switch (global) {
        case 0:
            out.fileId = { type: m[0], manufacturer: m[1], product: m[2], timeCreated: m[4], productName: m[8] || null };
            break;
        case 3:
            out.userProfile = { weightKg: scaled(m[4], 10) };
            break;
        case 7:
            out.zonesTarget = { maxHr: m[1], lthr: m[2], ftp: m[3] };
            break;
        case 12:
            out.sport = { sport: m[0], subSport: m[1] };
            break;
        case 18:
            out.sessions.push({
                start: m[2], sport: m[5], subSport: m[6],
                elapsedSec: scaled(m[7], 1000), timerSec: scaled(m[8], 1000),
                distanceM: scaled(m[9], 100), ascentM: m[22],
                avgPower: m[20], np: m[34], ftp: m[45]
            });
            break;
        case 20:
            if (m[253] !== null && m[253] !== undefined) out.records.push(m);
            break;
        case 21:
            out.events.push({ ts: m[253], event: m[0], type: m[1] });
            break;
        case 34:
            out.activity = { ts: m[253], localTs: m[5] };
            break;
    }
}

/* -------------------------- STREAMS & SUMMARY -------------------------- */

/* Per-sample channels, Float32 with NaN for "not recorded". Channels a ride
   never recorded are dropped entirely (indoor rides have no GPS, etc.). */
function buildStreams(fit) {
    const recs = fit.records.slice();
    for (let i = 1; i < recs.length; i++) {
        if (recs[i][253] < recs[i - 1][253]) { recs.sort((a, b) => a[253] - b[253]); break; }
    }
    const n = recs.length;
    if (n < 2) throw new FitError('The file has no recorded samples.');

    const t0 = recs[0][253];
    const t = new Int32Array(n);
    const make = () => new Float32Array(n).fill(NaN);
    const ch = { power: make(), hr: make(), cadence: make(), speed: make(),
                 altitude: make(), distance: make(), lat: make(), lng: make() };

    const set = (arr, i, v) => { if (v !== null && v !== undefined) arr[i] = v; };
    for (let i = 0; i < n; i++) {
        const r = recs[i];
        t[i] = r[253] - t0;
        set(ch.power, i, r[7]);
        set(ch.hr, i, r[3]);
        set(ch.cadence, i, r[4]);
        set(ch.speed, i, scaled(r[73] ?? r[6], 1000));
        set(ch.altitude, i, scaled(r[78] ?? r[2], 5, 500));
        set(ch.distance, i, scaled(r[5], 100));
        if (r[0] !== null && r[0] !== undefined && r[1] !== null && r[1] !== undefined) {
            ch.lat[i] = r[0] * SEMICIRCLE_DEG;
            ch.lng[i] = r[1] * SEMICIRCLE_DEG;
        }
    }

    const streams = { t };
    for (const [k, arr] of Object.entries(ch)) {
        if (arr.some((v) => !Number.isNaN(v))) streams[k] = arr;
    }
    return { startFit: t0, streams };
}

/* Seconds of timer time each sample stands for: the gap back to the previous
   sample, or 1 s across a pause (the sample that restarts the ride). */
function sampleWeights(t) {
    const w = new Uint16Array(t.length);
    w[0] = 1;
    for (let i = 1; i < t.length; i++) {
        const dt = t[i] - t[i - 1];
        w[i] = dt <= 0 ? 0 : dt <= MAX_GAP_S ? dt : 1;
    }
    return w;
}

/* Normalized Power over the timer-time grid: 30 s rolling mean, fourth
   power, mean, fourth root. Missing power counts as 0, as on the device. */
function normalizedPower(power, w) {
    const grid = [];
    for (let i = 0; i < power.length; i++) {
        const p = Number.isNaN(power[i]) ? 0 : power[i];
        for (let k = 0; k < w[i]; k++) grid.push(p);
    }
    if (grid.length < NP_WINDOW_S) return null;
    let acc = 0;
    let sum4 = 0;
    let count = 0;
    for (let i = 0; i < grid.length; i++) {
        acc += grid[i];
        if (i >= NP_WINDOW_S) acc -= grid[i - NP_WINDOW_S];
        if (i >= NP_WINDOW_S - 1) {
            sum4 += (acc / NP_WINDOW_S) ** 4;
            count++;
        }
    }
    return (sum4 / count) ** 0.25;
}

/* Single-sample spikes - a reading more than twice BOTH neighbours and over
   300 W above them - and anything above a physiological cap are replaced by
   the mean of their neighbours. A real sprint ramps over several samples, so
   its neighbours are high too and it is left alone. The stored stream stays
   raw; every power figure is computed on this cleaned copy. */
function cleanPower(raw) {
    const power = Float32Array.from(raw);
    const fixed = [];
    const n = raw.length;
    for (let i = 0; i < n; i++) {
        const p = raw[i];
        if (Number.isNaN(p)) continue;
        /* Neighbours over the cap are garbage themselves and never used. */
        const nbs = [];
        for (const j of [i - 1, i + 1]) {
            if (j >= 0 && j < n && !Number.isNaN(raw[j]) && raw[j] <= POWER_CAP_W) nbs.push(raw[j]);
        }
        if (p > POWER_CAP_W) {
            power[i] = nbs.length ? nbs.reduce((a, b) => a + b, 0) / nbs.length : NaN;
            fixed.push(i);
            continue;
        }
        if (!nbs.length) continue;
        const nb = Math.max(...nbs);
        if (p > SPIKE_RATIO * nb && p - nb > SPIKE_MIN_JUMP_W) {
            power[i] = nbs.reduce((a, b) => a + b, 0) / nbs.length;
            fixed.push(i);
        }
    }
    return { power, fixed };
}

/* Per-second expansion of a channel over timer time (see sampleWeights). */
function timerGrid(values, w) {
    let len = 0;
    for (let i = 0; i < w.length; i++) len += w[i];
    const grid = new Float32Array(len);
    let k = 0;
    for (let i = 0; i < values.length; i++) {
        for (let j = 0; j < w[i]; j++) grid[k++] = values[i];
    }
    return grid;
}

/* Power per ELAPSED second with pauses as zeros, so a best effort can never
   be stitched together across a stop. Missing power is 0. */
function elapsedPowerGrid(t, power) {
    const n = t.length;
    const grid = new Float32Array(t[n - 1] - t[0] + 1);
    const val = (i) => (Number.isNaN(power[i]) ? 0 : power[i]);
    grid[0] = val(0);
    for (let i = 1; i < n; i++) {
        const dt = t[i] - t[i - 1];
        if (dt <= 0) continue;
        const at = t[i] - t[0];
        if (dt <= MAX_GAP_S) grid.fill(val(i), at - dt + 1, at + 1);
        else grid[at] = val(i);    /* the seconds before it stay 0 */
    }
    return grid;
}

/* Best average power for each duration, and the second it started at. */
function bestEfforts(grid, durations) {
    const out = [];
    for (const d of durations) {
        if (d > grid.length) continue;
        let acc = 0;
        for (let i = 0; i < d; i++) acc += grid[i];
        let best = acc;
        let start = 0;
        for (let i = d; i < grid.length; i++) {
            acc += grid[i] - grid[i - d];
            if (acc > best) { best = acc; start = i - d + 1; }
        }
        out.push({ sec: d, watts: best / d, start });
    }
    return out;
}

function zoneOf(ratio, lows) {
    let k = 0;
    for (let j = 0; j < lows.length; j++) if (ratio >= lows[j]) k = j;
    return k;
}

/* Seconds of timer time in each zone; samples without a value are skipped. */
function zoneSeconds(grid, ref, lows) {
    const secs = new Array(lows.length).fill(0);
    for (let i = 0; i < grid.length; i++) {
        if (!Number.isNaN(grid[i])) secs[zoneOf(grid[i] / ref, lows)]++;
    }
    return secs;
}

/* Pw:HR decoupling: watts per beat in the second half against the first,
   over the seconds that have both. Positive = heart rate drifted up. */
function decoupling(powerGrid, hrGrid) {
    const p = [];
    const h = [];
    for (let i = 0; i < powerGrid.length; i++) {
        if (!Number.isNaN(powerGrid[i]) && !Number.isNaN(hrGrid[i])) { p.push(powerGrid[i]); h.push(hrGrid[i]); }
    }
    if (p.length < DECOUPLING_MIN_S) return null;
    const half = Math.floor(p.length / 2);
    const sum = (arr, a, b) => { let s = 0; for (let i = a; i < b; i++) s += arr[i]; return s; };
    const ef1 = sum(p, 0, half) / sum(h, 0, half);
    const ef2 = sum(p, half, p.length) / sum(h, half, h.length);
    return ef1 > 0 ? ((ef1 - ef2) / ef1) * 100 : null;
}

/* The FTP that applies on the ride's date. Step 4 replaces this with the
   model-driven timeline; until then: the latest manual entry on or before
   the date, else what the head unit had set for that ride, else the most
   recent Garmin value from any earlier ride. */
function ftpForRide(ride) {
    const date = fmtDate(ride);
    const manual = rideState.settings.ftpEntries.filter((e) => e.date <= date);
    if (manual.length) return { watts: manual[manual.length - 1].watts, source: 'manual entry from ' + manual[manual.length - 1].date };
    if (isNum(ride.deviceFtp)) return { watts: ride.deviceFtp, source: 'set on your Garmin' };
    let best = null;
    for (const r of rideState.rides) {
        if (isNum(r.deviceFtp) && r.startUnix <= ride.startUnix && (!best || r.startUnix > best.startUnix)) best = r;
    }
    return best ? { watts: best.deviceFtp, source: 'Garmin, from ' + fmtDate(best) } : null;
}

/* Threshold HR for zones: setting, else this ride's device value, else the
   latest one; max HR is the fallback reference with a 5-zone scheme. */
function hrReference(ride) {
    const s = rideState.settings;
    const lthr = s.lthr ?? ride.lthr ?? latestDeviceValue('lthr');
    if (isNum(lthr)) return { ref: lthr, lows: HR_ZONE_LOWS, names: HR_ZONE_NAMES, basis: 'threshold HR ' + lthr + ' bpm' };
    const max = s.maxHr ?? ride.maxHrSetting ?? latestDeviceValue('maxHrSetting');
    if (isNum(max)) return { ref: max, lows: HR_MAX_ZONE_LOWS, names: HR_MAX_ZONE_NAMES, basis: 'max HR ' + max + ' bpm' };
    return null;
}

/* Everything the activity view derives from the streams. */
function analyseRide(ride, streams) {
    const w = sampleWeights(streams.t);
    const out = { ftp: ftpForRide(ride), hrRef: hrReference(ride), cleaned: null,
                  best: [], powerZones: null, hrZones: null, decoupling: null,
                  intensity: null, tss: null };
    let powerGrid = null;
    if (streams.power) {
        out.cleaned = cleanPower(streams.power);
        out.best = bestEfforts(elapsedPowerGrid(streams.t, out.cleaned.power), BEST_EFFORT_S);
        powerGrid = timerGrid(out.cleaned.power, w);
        if (out.ftp) {
            out.powerZones = zoneSeconds(powerGrid, out.ftp.watts, POWER_ZONE_LOWS);
            if (isNum(ride.np)) {
                out.intensity = ride.np / out.ftp.watts;
                out.tss = (ride.timerSec * ride.np * out.intensity) / (out.ftp.watts * 3600) * 100;
            }
        }
    }
    if (streams.hr) {
        const hrGrid = timerGrid(streams.hr, w);
        if (out.hrRef) out.hrZones = zoneSeconds(hrGrid, out.hrRef.ref, out.hrRef.lows);
        if (powerGrid) out.decoupling = decoupling(powerGrid, hrGrid);
    }
    return out;
}

function summarise(fit, streams) {
    const { t } = streams;
    const n = t.length;
    const w = sampleWeights(t);
    const session = fit.sessions[0] || {};
    const has = (k) => Boolean(streams[k]);
    const at = (k, i) => (streams[k] ? streams[k][i] : NaN);
    const cleaned = streams.power ? cleanPower(streams.power) : null;
    const power = cleaned ? cleaned.power : null;

    let timerSec = 0, movingSec = 0;
    let powerSum = 0, maxPower = null, powerGapSec = 0;
    let hrSum = 0, hrW = 0, maxHr = null;
    let cadSum = 0, cadW = 0;
    let maxSpeed = null, speedDist = 0;

    for (let i = 0; i < n; i++) {
        const wi = w[i];
        if (!wi) continue;
        timerSec += wi;
        const p = power ? power[i] : NaN, hr = at('hr', i), cad = at('cadence', i), v = at('speed', i);
        if (power && Number.isNaN(p)) powerGapSec += wi;
        if (v > MOVING_SPEED_MS || p > 0 || cad > 0) movingSec += wi;
        if (!Number.isNaN(p)) {
            powerSum += p * wi;
            if (maxPower === null || p > maxPower) maxPower = p;
        }
        if (!Number.isNaN(hr)) {
            hrSum += hr * wi; hrW += wi;
            if (maxHr === null || hr > maxHr) maxHr = hr;
        }
        if (cad > 0) { cadSum += cad * wi; cadW += wi; }
        if (!Number.isNaN(v)) {
            speedDist += v * wi;
            if (maxSpeed === null || v > maxSpeed) maxSpeed = v;
        }
    }

    let distanceM = null;
    if (has('distance')) {
        const d = streams.distance;
        let first = NaN, last = NaN;
        for (let i = 0; i < n && Number.isNaN(first); i++) first = d[i];
        for (let i = n - 1; i >= 0 && Number.isNaN(last); i--) last = d[i];
        distanceM = last - first;
    } else if (has('speed')) {
        distanceM = speedDist;
    } else if (isNum(session.distanceM)) {
        distanceM = session.distanceM;
    }

    /* A barometric device's own ascent beats anything derived from samples. */
    let ascentM = isNum(session.ascentM) ? session.ascentM : null;
    if (ascentM === null && has('altitude')) {
        const a = streams.altitude;
        let ref = NaN;
        ascentM = 0;
        for (let i = 0; i < n; i++) {
            if (Number.isNaN(a[i])) continue;
            if (Number.isNaN(ref) || a[i] < ref) ref = a[i];
            else if (a[i] - ref >= ASCENT_HYSTERESIS_M) { ascentM += a[i] - ref; ref = a[i]; }
        }
    }

    const hasPower = has('power');
    return {
        elapsedSec: t[n - 1] - t[0],
        timerSec,
        movingSec,
        distanceM,
        avgSpeed: distanceM !== null && movingSec ? distanceM / movingSec : null,
        maxSpeed,
        ascentM,
        avgPower: hasPower ? powerSum / timerSec : null,
        maxPower: hasPower ? maxPower : null,
        np: hasPower ? normalizedPower(power, w) : null,
        workKj: hasPower ? powerSum / 1000 : null,
        spikesFixed: cleaned ? cleaned.fixed.length : 0,
        powerGapSec,
        avgHr: hrW ? hrSum / hrW : null,
        maxHr,
        avgCadence: cadW ? cadSum / cadW : null
    };
}

/* true / false, or null when the file does not say (sport 0 is "generic"). */
function isCyclingFit(fit) {
    const sport = (fit.sessions[0] ? fit.sessions[0].sport : null) ?? (fit.sport ? fit.sport.sport : null);
    if (sport === null || sport === undefined || sport === 0) return null;
    return sport === FIT_SPORT_CYCLING;
}

/* FIT bytes + optional CSV row -> { ride, streams } ready for storage. */
function buildRide(buffer, meta, sourceName) {
    const fit = parseFit(buffer);
    const { startFit, streams } = buildStreams(fit);
    const session = fit.sessions[0] || {};
    const sport = session.sport ?? (fit.sport && fit.sport.sport) ?? null;
    const subSport = session.subSport ?? (fit.sport && fit.sport.subSport) ?? null;
    const startUnix = startFit + FIT_EPOCH_S;
    const act = fit.activity;
    const tzOffsetSec = act && isNum(act.localTs) && isNum(act.ts) ? act.localTs - act.ts : 0;
    const fid = fit.fileId || {};
    const device = fid.productName || FIT_MANUFACTURER[fid.manufacturer] || null;
    const type = (meta && meta.type) || FIT_SUB_SPORT[subSport] || 'Ride';

    const ride = Object.assign({
        id: 'r' + startUnix,
        stravaId: meta ? meta.stravaId : null,
        name: (meta && meta.name) || type,
        type,
        gear: (meta && meta.gear) || null,
        sport,
        subSport,
        startUnix,
        tzOffsetSec,
        device,
        deviceFtp: session.ftp ?? (fit.zonesTarget && fit.zonesTarget.ftp) ?? null,
        maxHrSetting: (fit.zonesTarget && fit.zonesTarget.maxHr) ?? null,
        lthr: (fit.zonesTarget && fit.zonesTarget.lthr) ?? null,
        weightKg: (fit.userProfile && fit.userProfile.weightKg) ?? null,
        channels: Object.keys(streams).filter((k) => k !== 't'),
        samples: streams.t.length,
        warnings: fit.warnings,
        source: sourceName,
        parser: PARSER_VERSION,
        importedAt: Date.now()
    }, summarise(fit, streams));

    return { ride, streams: Object.assign({ id: ride.id }, streams), cycling: isCyclingFit(fit) };
}

/* ------------------------------ ZIP & GZIP ----------------------------- */

async function inflate(blob, format) {
    const stream = blob.stream().pipeThrough(new DecompressionStream(format));
    return new Response(stream).arrayBuffer();
}

const u64 = (view, off) => Number(view.getBigUint64(off, true));

/* Reads only the central directory, never the whole archive: an export with
   photos can be several GB and only a few MB of it are needed. */
async function zipEntries(blob) {
    const tailLen = Math.min(blob.size, 22 + 65535 + 20);
    const tailStart = blob.size - tailLen;
    const tail = new DataView(await blob.slice(tailStart).arrayBuffer());

    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
        if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file.');

    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);

    /* ZIP64: exports over 4 GB, or with more than 65535 entries. */
    if ((count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) &&
        eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
        const z64Off = u64(tail, eocd - 20 + 8);
        const z64 = new DataView(await blob.slice(z64Off, z64Off + 56).arrayBuffer());
        if (z64.getUint32(0, true) !== 0x06064b50) throw new Error('Damaged ZIP64 directory.');
        count = u64(z64, 32);
        cdSize = u64(z64, 40);
        cdOffset = u64(z64, 48);
    }

    const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
        if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged ZIP directory.');
        const method = cd.getUint16(p + 10, true);
        let compSize = cd.getUint32(p + 20, true);
        let size = cd.getUint32(p + 24, true);
        const nameLen = cd.getUint16(p + 28, true);
        const extraLen = cd.getUint16(p + 30, true);
        const commentLen = cd.getUint16(p + 32, true);
        let localOffset = cd.getUint32(p + 42, true);
        const name = utf8.decode(new Uint8Array(cd.buffer, p + 46, nameLen));

        /* The ZIP64 extra field holds, in this order, only those of the
           three values that overflowed to 0xFFFFFFFF. */
        let e = p + 46 + nameLen;
        const eEnd = e + extraLen;
        while (e + 4 <= eEnd) {
            const id = cd.getUint16(e, true);
            const len = cd.getUint16(e + 2, true);
            if (id === 0x0001) {
                let q = e + 4;
                if (size === 0xFFFFFFFF) { size = u64(cd, q); q += 8; }
                if (compSize === 0xFFFFFFFF) { compSize = u64(cd, q); q += 8; }
                if (localOffset === 0xFFFFFFFF) { localOffset = u64(cd, q); }
            }
            e += 4 + len;
        }
        entries.push({ name, method, compSize, size, localOffset });
        p = eEnd + commentLen;
    }
    return entries;
}

async function zipRead(blob, entry) {
    const lh = new DataView(await blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('Damaged ZIP entry: ' + entry.name);
    const dataStart = entry.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = blob.slice(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return raw.arrayBuffer();
    if (entry.method === 8) return inflate(raw, 'deflate-raw');
    throw new Error('Unsupported ZIP compression (method ' + entry.method + '): ' + entry.name);
}

/* ------------------------------ CSV ------------------------------------ */

function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
            } else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/* activities.csv -> rows keyed for lookup. Strava's column order is stable
   (ID, Date, Name, Type, ...) while the header text is localised, so
   positions are the fallback and the filename column is found by content. */
function readActivitiesCsv(text) {
    const rows = parseCsv(text);
    const header = rows.shift() || [];
    const find = (re, fallback) => {
        const i = header.findIndex((h) => re.test(h.trim()));
        return i >= 0 ? i : fallback;
    };
    const iName = find(/^activity name$|^name der aktivit|^aktivitätsname/i, 2);
    const iType = find(/^activity type$|^aktivitätsart|^aktivitätstyp|^sportart/i, 3);
    const iGear = find(/gear|ausrüstung/i, -1);
    let iFile = find(/^filename$|^dateiname$/i, -1);
    if (iFile < 0) iFile = header.findIndex((_, c) => rows.some((r) => /^activities\//i.test(r[c] || '')));

    return rows.map((r) => ({
        stravaId: r[0] || null,
        name: (r[iName] || '').trim() || null,
        type: (r[iType] || '').trim() || null,
        gear: iGear >= 0 ? (r[iGear] || '').trim() || null : null,
        file: iFile >= 0 ? (r[iFile] || '').trim() || null : null
    }));
}

/* ----------------------------- STORAGE --------------------------------- */

let dbPromise = null;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('rides')) db.createObjectStore('rides', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('streams')) db.createObjectStore('streams', { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
}

function reqDone(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbPutRide(ride, streams) {
    const db = await openDb();
    const tx = db.transaction(['rides', 'streams'], 'readwrite');
    tx.objectStore('rides').put(ride);
    tx.objectStore('streams').put(streams);
    await txDone(tx);
}

async function dbAllRides() {
    const db = await openDb();
    return reqDone(db.transaction('rides').objectStore('rides').getAll());
}

async function dbStreams(id) {
    const db = await openDb();
    return reqDone(db.transaction('streams').objectStore('streams').get(id));
}

async function dbClear() {
    const db = await openDb();
    const tx = db.transaction(['rides', 'streams'], 'readwrite');
    tx.objectStore('rides').clear();
    tx.objectStore('streams').clear();
    await txDone(tx);
}

/* ----------------------------- SETTINGS -------------------------------- */

function defaultSettings() {
    return { weightKg: null, maxHr: null, lthr: null, ftpEntries: [],
             windows: [DEFAULT_WINDOW_DAYS], defaultWindow: DEFAULT_WINDOW_DAYS };
}

function loadSettings() {
    const s = defaultSettings();
    try {
        const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        if (raw && typeof raw === 'object') {
            for (const k of ['weightKg', 'maxHr', 'lthr']) if (isNum(raw[k])) s[k] = raw[k];
            if (Array.isArray(raw.ftpEntries)) {
                s.ftpEntries = raw.ftpEntries.filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && isNum(e.watts));
            }
            if (Array.isArray(raw.windows)) {
                const ws = raw.windows.filter((d) => Number.isInteger(d) && d >= WINDOW_MIN_DAYS && d <= WINDOW_MAX_DAYS);
                if (ws.length) s.windows = [...new Set(ws)].sort((a, b) => a - b);
            }
            if (s.windows.includes(raw.defaultWindow)) s.defaultWindow = raw.defaultWindow;
            else if (!s.windows.includes(s.defaultWindow)) s.defaultWindow = s.windows[0];
        }
    } catch (e) { /* unreadable or blocked storage: defaults */ }
    return s;
}

function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(rideState.settings)); } catch (e) { /* ignore */ }
}

function addWindow(days) {
    const d = Number(days);
    if (!Number.isInteger(d) || d < WINDOW_MIN_DAYS || d > WINDOW_MAX_DAYS) {
        return 'Enter whole days between ' + WINDOW_MIN_DAYS + ' and ' + WINDOW_MAX_DAYS + '.';
    }
    const s = rideState.settings;
    if (s.windows.includes(d)) return d + ' days is already in the list.';
    s.windows = [...s.windows, d].sort((a, b) => a - b);
    saveSettings();
    return null;
}

function removeWindow(days) {
    const s = rideState.settings;
    if (days === s.defaultWindow) return;
    s.windows = s.windows.filter((d) => d !== days);
    saveSettings();
}

function setDefaultWindow(days) {
    if (!rideState.settings.windows.includes(days)) return;
    rideState.settings.defaultWindow = days;
    saveSettings();
}

function addFtpEntry(date, watts, note) {
    const w = Number(watts);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return 'Pick a date.';
    if (!Number.isInteger(w) || w < 50 || w > 600) return 'FTP must be whole watts between 50 and 600.';
    const s = rideState.settings;
    /* One entry per day: a second one on the same date replaces it. */
    s.ftpEntries = s.ftpEntries.filter((e) => e.date !== date)
        .concat({ date, watts: w, note: (note || '').trim().slice(0, 80) })
        .sort((a, b) => a.date.localeCompare(b.date));
    saveSettings();
    return null;
}

function removeFtpEntry(date) {
    rideState.settings.ftpEntries = rideState.settings.ftpEntries.filter((e) => e.date !== date);
    saveSettings();
}

/* The FTP the head unit held, reduced to the rides where it changed. */
function deviceFtpHistory(rides) {
    const out = [];
    let last = null;
    for (const r of rides.slice().sort((a, b) => a.startUnix - b.startUnix)) {
        if (!isNum(r.deviceFtp) || r.deviceFtp === last) continue;
        out.push({ date: fmtDate(r), watts: r.deviceFtp, rideId: r.id });
        last = r.deviceFtp;
    }
    return out;
}

/* Latest value a ride recorded for a given field, as the settings fallback. */
function latestDeviceValue(field) {
    let best = null;
    for (const r of rideState.rides) {
        if (isNum(r[field]) && (!best || r.startUnix > best.startUnix)) best = r;
    }
    return best ? best[field] : null;
}

/* ------------------------------ IMPORT --------------------------------- */

const rideState = {
    rides: [],
    settings: defaultSettings(),
    importing: false,
    cancel: false,
    lastReport: null,
    sort: { key: 'startUnix', dir: -1 },
    shown: LIST_PAGE,
    current: null,
    openToken: 0,
    act: null       /* the open ride: { ride, streams, analysis, chart, map, ... } */
};

function newReport() {
    return { imported: 0, updated: 0, skipped: { notCycling: [], unsupportedFormat: [], noFile: [], missingFile: [] },
             failed: [], cancelled: false };
}

const isFitName = (name) => /\.fit(\.gz)?$/i.test(name);
const isActivityName = (name) => /\.(fit|gpx|tcx)(\.gz)?$/i.test(name);
const csvSaysCycling = (meta) => (meta && meta.type ? CSV_CYCLING_TYPE.test(meta.type) : null);
const label = (meta, name) => (meta && meta.name ? meta.name + ' (' + name + ')' : name);

/* Every source (ZIP entry, picked file, folder file) is reduced to
   { name, read(): Promise<ArrayBuffer> } plus its CSV row, if any. */
async function importItems(items, csvRows, report, onProgress) {
    const byFile = new Map();
    for (const it of items) byFile.set(basename(it.name), it);

    const queue = [];
    const seen = new Set();
    for (const row of csvRows) {
        const cyc = csvSaysCycling(row);
        if (!row.file) {
            (cyc === false ? report.skipped.notCycling : report.skipped.noFile).push(row.name || row.stravaId);
            continue;
        }
        const key = basename(row.file);
        const item = byFile.get(key);
        if (!item) {
            (cyc === false ? report.skipped.notCycling : report.skipped.missingFile).push(label(row, row.file));
            continue;
        }
        seen.add(key);
        queue.push({ item, meta: row });
    }
    for (const [key, item] of byFile) if (!seen.has(key)) queue.push({ item, meta: null });

    const existing = new Map(rideState.rides.map((r) => [r.id, r]));
    for (let i = 0; i < queue.length; i++) {
        if (rideState.cancel) { report.cancelled = true; break; }
        const { item, meta } = queue[i];
        onProgress(i, queue.length, item.name);

        if (!isFitName(item.name)) {
            const bucket = csvSaysCycling(meta) === false ? 'notCycling' : 'unsupportedFormat';
            report.skipped[bucket].push(label(meta, item.name));
            continue;
        }

        try {
            let buf = await item.read();
            if (/\.gz$/i.test(item.name)) buf = await inflate(new Blob([buf]), 'gzip');
            const built = buildRide(buf, meta, item.name);
            /* The FIT sport field is the authority; the CSV type (localised,
               so matched loosely) only decides for files that do not say.
               A file nobody classifies is kept rather than lost. */
            const cycling = built.cycling ?? csvSaysCycling(meta) ?? true;
            if (!cycling) { report.skipped.notCycling.push(label(meta, item.name)); continue; }

            /* A loose FIT file has no CSV row; keep what an earlier export
               import learned about this ride instead of renaming it. */
            const prev = existing.get(built.ride.id);
            if (prev && !meta) {
                for (const k of ['stravaId', 'name', 'type', 'gear']) built.ride[k] = prev[k];
            }
            await dbPutRide(built.ride, built.streams);
            if (prev) report.updated++;
            else report.imported++;
            existing.set(built.ride.id, built.ride);
        } catch (err) {
            report.failed.push({ file: label(meta, item.name), error: err && err.message ? err.message : String(err) });
        }
        /* Yield so the progress bar paints during a 500-file import. */
        if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));
    }
    onProgress(queue.length, queue.length, '');
}

async function importZip(file, report, onProgress) {
    const entries = await zipEntries(file);
    const csvEntry = entries.find((e) => /(^|\/)activities\.csv$/i.test(e.name));
    let csvRows = [];
    if (csvEntry) csvRows = readActivitiesCsv(utf8.decode(await zipRead(file, csvEntry)));
    const items = entries
        .filter((e) => /(^|\/)activities\/[^/]+$/i.test(e.name) && isActivityName(e.name))
        .map((e) => ({ name: e.name, read: () => zipRead(file, e) }));
    await importItems(items, csvRows, report, onProgress);
}

/* Entry point for every way files arrive: drop, picker or folder. */
async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    const report = newReport();
    if (!files.length || rideState.importing) return report;

    rideState.importing = true;
    rideState.cancel = false;
    showProgress(true);
    const onProgress = (done, total, name) => updateProgress(done, total, name);

    try {
        for (const zip of files.filter((f) => /\.zip$/i.test(f.name))) {
            try {
                await importZip(zip, report, onProgress);
            } catch (err) {
                report.failed.push({ file: zip.name, error: err.message || String(err) });
            }
        }
        const loose = files.filter((f) => !/\.zip$/i.test(f.name));
        const csvFile = loose.find((f) => /(^|[\\/])activities\.csv$/i.test(f.webkitRelativePath || f.name));
        const csvRows = csvFile ? readActivitiesCsv(await csvFile.text()) : [];
        const items = loose
            .filter((f) => isActivityName(f.name))
            .map((f) => ({ name: f.name, read: () => f.arrayBuffer() }));
        if (items.length || csvRows.length) await importItems(items, csvRows, report, onProgress);
    } finally {
        rideState.importing = false;
        rideState.rides = await dbAllRides();
        rideState.lastReport = report;
        showProgress(false);
        renderAll();
        renderReport(report);
    }
    return report;
}

/* -------------------------------- UI ----------------------------------- */

function showProgress(on) {
    $('raProgress').hidden = !on;
    if (on) updateProgress(0, 0, '');
}

function updateProgress(done, total, name) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('raProgressFill').style.width = pct + '%';
    $('raProgressText').textContent = total
        ? 'Reading ' + done + ' of ' + total + (name ? ' — ' + basename(name) : '')
        : 'Reading archive…';
}

function renderReport(report) {
    const box = $('raReport');
    box.replaceChildren();
    const sk = report.skipped;
    const lines = [
        ['imported', report.imported, 'new rides imported'],
        ['updated', report.updated, 'rides already stored, updated'],
        ['notCycling', sk.notCycling.length, 'not cycling (runs and other sports)', sk.notCycling],
        ['unsupportedFormat', sk.unsupportedFormat.length, 'in GPX/TCX format, not supported yet', sk.unsupportedFormat],
        ['noFile', sk.noFile.length, 'without a file (manual entries)', sk.noFile],
        ['missingFile', sk.missingFile.length, 'listed in activities.csv but missing from the archive', sk.missingFile],
        ['failed', report.failed.length, 'could not be read', report.failed.map((f) => f.file + ': ' + f.error)]
    ];
    box.appendChild(el('h3', { text: report.cancelled ? 'Import cancelled' : 'Import finished' }));
    const ul = el('ul', { class: 'ra-report-list' });
    for (const [key, count, text, list] of lines) {
        if (!count) continue;
        const li = el('li', { 'data-kind': key, class: key === 'failed' ? 'bad' : null },
            [el('strong', { text: String(count) }), ' ' + text]);
        if (list && list.length) {
            li.appendChild(el('details', null, [el('summary', { text: 'show' }),
                el('ul', null, list.slice(0, 200).map((x) => el('li', { text: String(x) })))]));
        }
        ul.appendChild(li);
    }
    if (!ul.children.length) ul.appendChild(el('li', { text: 'No activity files found.' }));
    box.appendChild(ul);
    box.hidden = false;
}

function renderLibrary() {
    const rides = rideState.rides;
    if (!rides.length) {
        $('raLibrarySummary').textContent = 'No rides stored yet.';
    } else {
        const sorted = rides.map((r) => r.startUnix).sort((a, b) => a - b);
        const first = rides.find((r) => r.startUnix === sorted[0]);
        const last = rides.find((r) => r.startUnix === sorted[sorted.length - 1]);
        const stale = rides.filter((r) => (r.parser || 0) < PARSER_VERSION).length;
        $('raLibrarySummary').textContent = rides.length + ' rides stored, ' + fmtDate(first) + ' to ' + fmtDate(last) + '.' +
            (stale ? ' ' + stale + ' were imported with an older version — import the export again to update their figures.' : '');
    }
    if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then((e) => {
            $('raStorage').textContent = isNum(e.usage) ? 'Using about ' + (e.usage / 1048576).toFixed(1) + ' MB of browser storage.' : '';
        }).catch(() => {});
    }
}

function renderSettings() {
    const s = rideState.settings;
    const fill = (id, key, field) => {
        const input = $(id);
        if (document.activeElement !== input) input.value = isNum(s[key]) ? s[key] : '';
        const dev = latestDeviceValue(field);
        input.placeholder = isNum(dev) ? 'Garmin: ' + dev : '';
    };
    fill('raWeight', 'weightKg', 'weightKg');
    fill('raMaxHr', 'maxHr', 'maxHrSetting');
    fill('raLthr', 'lthr', 'lthr');

    const chips = $('raWindowChips');
    chips.replaceChildren();
    for (const d of s.windows) {
        const isDefault = d === s.defaultWindow;
        chips.appendChild(el('span', { class: 'ra-chip' + (isDefault ? ' on' : '') }, [
            el('button', {
                type: 'button', class: 'ra-chip-main', 'data-window': String(d),
                title: isDefault ? 'Default window' : 'Make this the default',
                'aria-pressed': isDefault ? 'true' : 'false',
                onclick: () => { setDefaultWindow(d); renderSettings(); }
            }, [d + ' days', isDefault ? el('small', { text: ' default' }) : null]),
            isDefault ? null : el('button', {
                type: 'button', class: 'ra-chip-x', 'aria-label': 'Remove ' + d + ' days',
                onclick: () => { removeWindow(d); renderSettings(); }
            }, '×')
        ]));
    }

    const manual = $('raFtpManual');
    manual.replaceChildren();
    if (!s.ftpEntries.length) manual.appendChild(el('p', { class: 'ra-muted small', text: 'No entries yet.' }));
    else {
        manual.appendChild(el('table', { class: 'ra-table compact' }, [
            el('tbody', null, s.ftpEntries.slice().reverse().map((e) => el('tr', null, [
                el('td', { text: e.date }),
                el('td', { class: 'num', text: e.watts + ' W' }),
                el('td', { class: 'ra-muted', text: e.note || '' }),
                el('td', { class: 'num' }, el('button', {
                    type: 'button', class: 'ra-link', 'aria-label': 'Remove entry from ' + e.date,
                    onclick: () => { removeFtpEntry(e.date); renderSettings(); }
                }, 'remove'))
            ])))
        ]));
    }

    const device = $('raFtpDevice');
    device.replaceChildren();
    const hist = deviceFtpHistory(rideState.rides);
    if (!hist.length) device.appendChild(el('p', { class: 'ra-muted small', text: 'Appears once rides are imported.' }));
    else {
        device.appendChild(el('table', { class: 'ra-table compact' }, [
            el('tbody', null, hist.slice().reverse().map((h) => el('tr', null, [
                el('td', { text: h.date }),
                el('td', { class: 'num', text: h.watts + ' W' })
            ])))
        ]));
    }
}

function filteredRides() {
    const q = $('raSearch').value.trim().toLowerCase();
    const from = $('raFrom').value;
    const to = $('raTo').value;
    const type = $('raType').value;
    const { key, dir } = rideState.sort;
    return rideState.rides.filter((r) => {
        const d = fmtDate(r);
        if (from && d < from) return false;
        if (to && d > to) return false;
        if (type && r.type !== type) return false;
        if (q && ![r.name, r.type, r.gear].some((v) => v && v.toLowerCase().includes(q))) return false;
        return true;
    }).sort((a, b) => {
        const x = a[key], y = b[key];
        /* Missing values sink to the bottom whichever way the column sorts. */
        if (x === null || x === undefined) return (y === null || y === undefined) ? 0 : 1;
        if (y === null || y === undefined) return -1;
        return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });
}

function renderList() {
    const types = [...new Set(rideState.rides.map((r) => r.type))].sort();
    const typeSel = $('raType');
    const current = typeSel.value;
    typeSel.replaceChildren(el('option', { value: '', text: 'All types' }),
        ...types.map((t) => el('option', { value: t, text: t })));
    typeSel.value = types.includes(current) ? current : '';

    const rides = filteredRides();
    const tbody = $('raTable').tBodies[0];
    tbody.replaceChildren(...rides.slice(0, rideState.shown).map((r) => el('tr', {
        tabindex: '0', 'data-id': r.id,
        onclick: () => openRide(r.id),
        onkeydown: (e) => { if (e.key === 'Enter') openRide(r.id); }
    }, [
        el('td', { text: fmtDate(r) }),
        el('td', { class: 'ra-name', text: r.name }),
        el('td', { class: 'ra-muted', text: r.type }),
        el('td', { class: 'num', text: fmtKm(r.distanceM) }),
        el('td', { class: 'num', text: fmtDuration(r.movingSec) }),
        el('td', { class: 'num', text: fmtInt(r.ascentM) }),
        el('td', { class: 'num', text: fmtInt(r.avgPower) }),
        el('td', { class: 'num', text: fmtInt(r.np) }),
        el('td', { class: 'num', text: fmtInt(r.avgHr) }),
        el('td', { class: 'num', text: fmtInt(r.deviceFtp) })
    ])));

    const sum = (k) => rides.reduce((a, r) => a + (isNum(r[k]) ? r[k] : 0), 0);
    $('raTable').tFoot.replaceChildren(rides.length ? el('tr', null, [
        el('td', { colspan: '3', text: rides.length + ' rides' }),
        el('td', { class: 'num', text: fmtKm(sum('distanceM')) }),
        el('td', { class: 'num', text: fmtDuration(sum('movingSec')) }),
        el('td', { class: 'num', text: fmtInt(sum('ascentM')) }),
        el('td', { colspan: '4' })
    ]) : '');

    for (const th of $('raTable').tHead.rows[0].cells) {
        const on = th.dataset.sort === rideState.sort.key;
        th.classList.toggle('sorted', on);
        th.classList.toggle('desc', on && rideState.sort.dir < 0);
        th.setAttribute('aria-sort', on ? (rideState.sort.dir < 0 ? 'descending' : 'ascending') : 'none');
    }

    $('raListCount').textContent = rideState.rides.length
        ? 'Showing ' + Math.min(rides.length, rideState.shown) + ' of ' + rides.length : '';
    $('raEmpty').hidden = rideState.rides.length > 0;
    $('raEmpty').textContent = rideState.rides.length ? '' : 'Import your export above to see your rides here.';
    if (rideState.rides.length && !rides.length) {
        $('raEmpty').hidden = false;
        $('raEmpty').textContent = 'No rides match these filters.';
    }
    $('raMoreBtn').hidden = rides.length <= rideState.shown;
}

function showView(view) {
    for (const tab of document.querySelectorAll('.ra-tab')) {
        tab.setAttribute('aria-selected', tab.dataset.view === view ? 'true' : 'false');
    }
    $('raViewActivities').hidden = view !== 'activities';
    $('raViewActivity').hidden = view !== 'activity';
}

/* ------------------------------ ROUTING -------------------------------- */

/* #ride=<id> keeps an open ride across reloads and makes Back work. */
function setRoute(hash) {
    const want = hash ? '#' + hash : '';
    if (location.hash === want) return;
    history.pushState(null, '', want || location.pathname + location.search);
}

function route() {
    const m = /^#ride=(r\d+)$/.exec(location.hash);
    if (m && rideState.rides.some((r) => r.id === m[1])) openRide(m[1], true);
    else showView('activities');
}

/* ----------------------------- ACTIVITY -------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
        if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

function fmtSpan(sec) {
    if (sec < 60) return sec + ' s';
    if (sec < 3600) return sec / 60 + ' min';
    return sec / 3600 + ' h';
}

function weightFor(ride) {
    return rideState.settings.weightKg ?? ride.weightKg ?? latestDeviceValue('weightKg');
}

/* Rounded tick values spanning [min, max], about `count` of them. */
function niceTicks(min, max, count) {
    if (!(max > min)) return [min];
    const raw = (max - min) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
}

/* Trailing mean over the last `sec` seconds of samples (NaN skipped). */
function rollingByTime(t, values, sec) {
    if (sec <= 1) return values;
    const out = new Float32Array(values.length);
    let lo = 0, sum = 0, cnt = 0;
    for (let i = 0; i < values.length; i++) {
        if (!Number.isNaN(values[i])) { sum += values[i]; cnt++; }
        while (t[lo] <= t[i] - sec) {
            if (!Number.isNaN(values[lo])) { sum -= values[lo]; cnt--; }
            lo++;
        }
        out[i] = cnt ? sum / cnt : NaN;
    }
    return out;
}

/* X coordinate per sample: elapsed seconds, or kilometres. Null when the
   ride has nothing to measure distance by. */
function xValues(streams, mode) {
    const { t } = streams;
    const n = t.length;
    const x = new Float64Array(n);
    if (mode !== 'distance') {
        for (let i = 0; i < n; i++) x[i] = t[i];
        return x;
    }
    if (streams.distance) {
        const d = streams.distance;
        let first = NaN;
        for (let i = 0; i < n && Number.isNaN(first); i++) first = d[i];
        let last = first;
        for (let i = 0; i < n; i++) {
            if (!Number.isNaN(d[i])) last = d[i];
            x[i] = (last - first) / 1000;
        }
        return x;
    }
    if (streams.speed) {
        const w = sampleWeights(t);
        let acc = 0;
        for (let i = 0; i < n; i++) {
            const v = streams.speed[i];
            if (i && !Number.isNaN(v) && t[i] - t[i - 1] <= MAX_GAP_S) acc += v * w[i];
            x[i] = acc / 1000;
        }
        return x;
    }
    return null;
}

/* Index of the last sample with x <= value. */
function indexAt(x, value) {
    let lo = 0, hi = x.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (x[mid] <= value) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function chartChannels(act) {
    const smooth = Number($('raSmooth').value) || 1;
    return CHANNELS.filter((c) => act.streams[c.key]).map((c) => {
        let values = c.key === 'power' && act.analysis.cleaned ? act.analysis.cleaned.power : act.streams[c.key];
        if (c.key === 'power') values = rollingByTime(act.streams.t, values, smooth);
        return Object.assign({}, c, { values });
    });
}

function renderChart() {
    const act = rideState.act;
    const box = $('raChart');
    box.replaceChildren();
    if (!act) return;

    const distOk = Boolean(xValues(act.streams, 'distance'));
    $('raXAxis').querySelector('option[value="distance"]').disabled = !distOk;
    if (!distOk) $('raXAxis').value = 'time';
    const mode = $('raXAxis').value;
    const x = xValues(act.streams, mode);
    const channels = chartChannels(act);
    if (!channels.length) {
        box.appendChild(el('p', { class: 'ra-empty', text: 'This ride has no sample data to chart.' }));
        return;
    }

    const W = Math.max(280, box.clientWidth || 800);
    const small = W < 600;
    const PH = small ? 72 : 96;
    const GAP = 10;
    const L = 44, R = 8, TOP = 6, AXIS = 22;
    const plotW = W - L - R;
    const H = TOP + channels.length * (PH + GAP) - GAP + AXIS;
    const x0 = x[0], x1 = x[x.length - 1] || 1;
    const toPx = (v) => L + ((v - x0) / (x1 - x0 || 1)) * plotW;

    const root = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'ra-chart-svg',
                              role: 'img', 'aria-label': 'Ride data over ' + (mode === 'distance' ? 'distance' : 'time') });
    /* Appended after the panels, so their opaque backgrounds cannot hide it. */
    const hl = svg('g', { class: 'ra-hl' });

    /* Bucket means, one per 2 px, so a 6-hour ride draws as fast as a short one. */
    const B = Math.max(50, Math.floor(plotW / 2));
    const bucketOf = (v) => Math.min(B - 1, Math.max(0, Math.floor(((v - x0) / (x1 - x0 || 1)) * B)));

    const panels = channels.map((c, k) => {
        const sums = new Float64Array(B), cnts = new Uint32Array(B);
        for (let i = 0; i < x.length; i++) {
            const v = c.values[i];
            if (Number.isNaN(v)) continue;
            const b = bucketOf(x[i]);
            sums[b] += v; cnts[b]++;
        }
        const means = Array.from(sums, (s, b) => (cnts[b] ? (s / cnts[b]) * (c.scale || 1) : NaN));
        const finite = means.filter((v) => !Number.isNaN(v));
        let lo = c.zero ? 0 : Math.min(...finite);
        let hi = Math.max(...finite);
        if (!(hi > lo)) hi = lo + 1;
        const pad = (hi - lo) * 0.06;
        if (!c.zero) lo -= pad;
        hi += pad;
        const y0 = TOP + k * (PH + GAP);
        const toY = (v) => y0 + PH - ((v - lo) / (hi - lo)) * PH;

        const g = svg('g', { class: 'ra-panel-g', 'data-channel': c.key });
        g.appendChild(svg('rect', { x: L, y: y0, width: plotW, height: PH, class: 'ra-plot-bg' }));
        for (const tick of niceTicks(lo, hi, small ? 2 : 3)) {
            const y = toY(tick);
            if (y < y0 || y > y0 + PH) continue;
            g.appendChild(svg('line', { x1: L, x2: L + plotW, y1: y, y2: y, class: 'ra-grid' }));
            g.appendChild(svg('text', { x: L - 6, y: y + 4, class: 'ra-tick', 'text-anchor': 'end' }, String(tick)));
        }

        let d = '';
        let segStart = -1;
        const segs = [];
        for (let b = 0; b < B; b++) {
            const v = means[b];
            const px = (L + ((b + 0.5) / B) * plotW).toFixed(1);
            if (Number.isNaN(v)) { if (segStart >= 0) segs.push([segStart, b - 1]); segStart = -1; continue; }
            d += (segStart < 0 ? 'M' : 'L') + px + ' ' + toY(v).toFixed(1);
            if (segStart < 0) segStart = b;
        }
        if (segStart >= 0) segs.push([segStart, B - 1]);
        if (c.area) {
            const base = (y0 + PH).toFixed(1);
            const area = segs.map(([a, b]) => {
                const pts = [];
                for (let i = a; i <= b; i++) pts.push((L + ((i + 0.5) / B) * plotW).toFixed(1) + ' ' + toY(means[i]).toFixed(1));
                return 'M' + pts[0].split(' ')[0] + ' ' + base + 'L' + pts.join('L') + 'L' + pts[pts.length - 1].split(' ')[0] + ' ' + base + 'Z';
            }).join('');
            g.appendChild(svg('path', { d: area, fill: c.color, 'fill-opacity': 0.18, stroke: 'none' }));
        }
        g.appendChild(svg('path', { d, fill: 'none', stroke: c.color, 'stroke-width': 1.4, class: 'ra-line',
                                    'stroke-linejoin': 'round' }));
        /* Label last, with a halo (see .ra-panel-label), so a line running
           along the top of the panel cannot bury it. */
        g.appendChild(svg('text', { x: L + 6, y: y0 + 13, class: 'ra-panel-label', fill: c.color },
            c.label + ' (' + c.unit + ')'));
        root.appendChild(g);
        return { c, y0, toY };
    });

    /* X axis under the last panel. */
    const axisY = TOP + channels.length * (PH + GAP) - GAP;
    const span = x1 - x0;
    const tickVals = mode === 'distance'
        ? niceTicks(x0, x1, small ? 4 : 8)
        : niceTicks(0, span / 60, small ? 4 : 8).map((m) => m * 60);
    for (const v of tickVals) {
        const px = toPx(mode === 'distance' ? v : x0 + v);
        if (px < L - 1 || px > L + plotW + 1) continue;
        root.appendChild(svg('text', { x: px, y: axisY + 16, class: 'ra-tick', 'text-anchor': 'middle' },
            mode === 'distance' ? v + ' km' : fmtDuration(v).replace(/:\d\d$/, '')));
    }

    root.appendChild(hl);
    const cross = svg('g', { class: 'ra-cross', visibility: 'hidden' });
    cross.appendChild(svg('line', { y1: TOP, y2: axisY, class: 'ra-cross-line' }));
    const dots = panels.map((p) => {
        const dot = svg('circle', { r: 3.5, fill: p.c.color, class: 'ra-cross-dot' });
        cross.appendChild(dot);
        return dot;
    });
    root.appendChild(cross);

    const overlay = svg('rect', { x: L, y: TOP, width: plotW, height: axisY - TOP, class: 'ra-overlay' });
    root.appendChild(overlay);
    box.appendChild(root);

    act.chart = { x, mode, toPx, panels, dots, cross, hl, top: TOP, bottom: axisY, L, plotW, x0, x1 };

    const hover = (evt) => {
        const rect = root.getBoundingClientRect();
        const px = Math.min(L + plotW, Math.max(L, evt.clientX - rect.left));
        setHover(indexAt(x, x0 + ((px - L) / plotW) * (x1 - x0)));
    };
    overlay.addEventListener('pointermove', hover);
    overlay.addEventListener('pointerdown', hover);
    overlay.addEventListener('pointerleave', () => setHover(null));

    drawHighlight();
    if (act.hover !== null) setHover(act.hover);
    else renderReadout(null);
}

function renderReadout(i) {
    const act = rideState.act;
    const box = $('raReadout');
    if (!act || !act.chart) { box.replaceChildren(); return; }
    const chans = act.chart.panels.map((p) => p.c);
    if (i === null) {
        box.replaceChildren(el('span', { class: 'ra-muted', text: 'Hover the chart for values' }));
        return;
    }
    const where = act.chart.mode === 'distance'
        ? act.chart.x[i].toFixed(2) + ' km'
        : fmtDuration(act.streams.t[i]);
    box.replaceChildren(el('span', { class: 'ra-readout-x', text: where }), ...chans.map((c) => {
        const v = c.values[i];
        return el('span', { class: 'ra-readout-item' }, [
            el('i', { style: 'background:' + c.color }),
            c.label + ' ',
            el('strong', { text: Number.isNaN(v) ? '–' : (v * (c.scale || 1)).toFixed(c.digits) }),
            ' ' + c.unit
        ]);
    }));
}

function setHover(i) {
    const act = rideState.act;
    if (!act || !act.chart) return;
    act.hover = i;
    const ch = act.chart;
    if (i === null) {
        ch.cross.setAttribute('visibility', 'hidden');
        renderReadout(null);
        moveMapMarker(null);
        return;
    }
    const px = ch.toPx(ch.x[i]);
    ch.cross.setAttribute('visibility', 'visible');
    const line = ch.cross.querySelector('line');
    line.setAttribute('x1', px);
    line.setAttribute('x2', px);
    ch.panels.forEach((p, k) => {
        const v = p.c.values[i];
        const dot = ch.dots[k];
        if (Number.isNaN(v)) { dot.setAttribute('visibility', 'hidden'); return; }
        dot.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', px);
        dot.setAttribute('cy', p.toY(v * (p.c.scale || 1)));
    });
    renderReadout(i);
    moveMapMarker(i);
}

/* Shade a best effort across every panel. `start` is in elapsed seconds. */
function drawHighlight() {
    const act = rideState.act;
    if (!act || !act.chart) return;
    const ch = act.chart;
    ch.hl.replaceChildren();
    const h = act.highlight;
    if (!h) return;
    const t = act.streams.t;
    const a = ch.x[indexAt(t, h.start)];
    const b = ch.x[indexAt(t, h.start + h.sec - 1)];
    const xa = ch.toPx(a);
    const xb = Math.max(ch.toPx(b), xa + 2);
    ch.hl.appendChild(svg('rect', { x: xa, y: ch.top, width: xb - xa, height: ch.bottom - ch.top, class: 'ra-hl-rect' }));
}

function setHighlight(h) {
    if (!rideState.act) return;
    rideState.act.highlight = h;
    drawHighlight();
    for (const tr of $('raBest').tBodies[0].rows) {
        tr.classList.toggle('on', Boolean(h) && Number(tr.dataset.sec) === h.sec);
    }
}

function renderMap() {
    const act = rideState.act;
    const box = $('raMap');
    box.replaceChildren();
    const { lat, lng } = act.streams;
    if (!lat || !lng) {
        act.map = null;
        box.appendChild(el('p', { class: 'ra-empty', text: 'No GPS data in this ride — an indoor session, or GPS was off.' }));
        return;
    }
    const idx = [];
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (let i = 0; i < lat.length; i++) {
        if (Number.isNaN(lat[i]) || Number.isNaN(lng[i])) continue;
        idx.push(i);
        if (lat[i] < minLat) minLat = lat[i];
        if (lat[i] > maxLat) maxLat = lat[i];
        if (lng[i] < minLng) minLng = lng[i];
        if (lng[i] > maxLng) maxLng = lng[i];
    }
    if (idx.length < 2) {
        act.map = null;
        box.appendChild(el('p', { class: 'ra-empty', text: 'Too few GPS points to draw a route.' }));
        return;
    }
    /* Equirectangular around the ride's middle latitude: exact enough at
       ride scale and needs no projection library. */
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const spanX = Math.max((maxLng - minLng) * kx, 1e-6);
    const spanY = Math.max(maxLat - minLat, 1e-6);
    const W = Math.max(260, box.clientWidth || 500);
    const P = 14;
    const scale = Math.min((W - 2 * P) / spanX, (Math.min(W, 420) - 2 * P) / spanY);
    const H = Math.round(spanY * scale + 2 * P);
    const offX = (W - spanX * scale) / 2;
    const project = (i) => [offX + (lng[i] - minLng) * kx * scale, P + (maxLat - lat[i]) * scale];

    const step = Math.max(1, Math.ceil(idx.length / 3000));
    const pts = [];
    for (let k = 0; k < idx.length; k += step) pts.push(project(idx[k]).map((v) => v.toFixed(1)).join(','));
    pts.push(project(idx[idx.length - 1]).map((v) => v.toFixed(1)).join(','));

    const [sx, sy] = project(idx[0]);
    const [ex, ey] = project(idx[idx.length - 1]);
    const marker = svg('circle', { r: 6, class: 'ra-map-marker', visibility: 'hidden' });
    const root = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'ra-map-svg',
                              role: 'img', 'aria-label': 'Route of the ride' }, [
        svg('polyline', { points: pts.join(' '), class: 'ra-route' }),
        svg('circle', { cx: sx, cy: sy, r: 5, class: 'ra-map-start' }, svg('title', null, 'Start')),
        svg('circle', { cx: ex, cy: ey, r: 5, class: 'ra-map-end' }, svg('title', null, 'Finish')),
        marker
    ]);
    box.appendChild(root);
    act.map = { project, marker, lat, lng };
}

function moveMapMarker(i) {
    const map = rideState.act && rideState.act.map;
    if (!map) return;
    if (i === null || Number.isNaN(map.lat[i]) || Number.isNaN(map.lng[i])) {
        map.marker.setAttribute('visibility', 'hidden');
        return;
    }
    const [x, y] = map.project(i);
    map.marker.setAttribute('cx', x);
    map.marker.setAttribute('cy', y);
    map.marker.setAttribute('visibility', 'visible');
}

function renderBest() {
    const act = rideState.act;
    const a = act.analysis;
    const tbody = $('raBest').tBodies[0];
    const kg = weightFor(act.ride);
    const notes = [];
    if (act.ride.spikesFixed) notes.push(act.ride.spikesFixed + ' power spike' + (act.ride.spikesFixed > 1 ? 's' : '') + ' removed');
    if (act.ride.powerGapSec) notes.push(act.ride.powerGapSec + ' s without power');
    $('raBestNote').textContent = notes.join(' · ');
    if (!a.best.length) {
        tbody.replaceChildren(el('tr', null, el('td', { colspan: '5', class: 'ra-muted', text: 'No power data in this ride.' })));
        return;
    }
    tbody.replaceChildren(...a.best.map((b) => {
        const h = { sec: b.sec, start: b.start };
        return el('tr', {
            tabindex: '0', 'data-sec': String(b.sec),
            onmouseenter: () => setHighlight(h),
            onmouseleave: () => setHighlight(null),
            onfocus: () => setHighlight(h),
            onblur: () => setHighlight(null)
        }, [
            el('td', { text: fmtSpan(b.sec) }),
            el('td', { class: 'num', text: Math.round(b.watts) + ' W' }),
            el('td', { class: 'num', text: isNum(kg) ? (b.watts / kg).toFixed(2) : '–' }),
            el('td', { class: 'num', text: a.ftp ? Math.round((b.watts / a.ftp.watts) * 100) + '%' : '–' }),
            el('td', { class: 'num ra-muted', text: fmtDuration(b.start) })
        ]);
    }));
}

function zoneBars(box, secs, lows, names, ref, unit) {
    const total = secs.reduce((s, v) => s + v, 0);
    const max = Math.max(...secs, 1);
    box.replaceChildren(...secs.map((s, k) => {
        const lo = Math.round(lows[k] * ref);
        const hi = k + 1 < lows.length ? Math.round(lows[k + 1] * ref) : null;
        const range = k === 0 ? '< ' + hi : hi === null ? '≥ ' + lo : lo + '–' + (hi - 1);
        return el('div', { class: 'ra-zone', 'data-zone': String(k + 1) }, [
            el('span', { class: 'ra-zone-name' }, [el('strong', { text: 'Z' + (k + 1) }), ' ' + names[k]]),
            el('span', { class: 'ra-zone-range ra-muted', text: range + ' ' + unit }),
            el('span', { class: 'ra-zone-track' }, el('span', {
                class: 'ra-zone-fill', style: 'width:' + ((s / max) * 100).toFixed(1) + '%;background:' + ZONE_COLORS[k % ZONE_COLORS.length]
            })),
            el('span', { class: 'ra-zone-time', text: fmtDuration(s) }),
            el('span', { class: 'ra-zone-pct ra-muted', text: total ? Math.round((s / total) * 100) + '%' : '' })
        ]);
    }));
}

function renderZones() {
    const act = rideState.act;
    const a = act.analysis;
    const pBox = $('raPowerZones');
    const hBox = $('raHrZones');
    if (!act.streams.power) {
        $('raPowerZoneNote').textContent = '';
        pBox.replaceChildren(el('p', { class: 'ra-empty', text: 'No power data in this ride.' }));
    } else if (!a.ftp) {
        $('raPowerZoneNote').textContent = '';
        pBox.replaceChildren(el('p', { class: 'ra-empty', text: 'Add an FTP in the settings to see power zones.' }));
    } else {
        $('raPowerZoneNote').textContent = 'FTP ' + a.ftp.watts + ' W, ' + a.ftp.source;
        zoneBars(pBox, a.powerZones, POWER_ZONE_LOWS, POWER_ZONE_NAMES, a.ftp.watts, 'W');
    }
    if (!act.streams.hr) {
        $('raHrZoneNote').textContent = '';
        hBox.replaceChildren(el('p', { class: 'ra-empty', text: 'No heart rate data in this ride.' }));
    } else if (!a.hrRef) {
        $('raHrZoneNote').textContent = '';
        hBox.replaceChildren(el('p', { class: 'ra-empty', text: 'Add a threshold or max heart rate in the settings to see zones.' }));
    } else {
        $('raHrZoneNote').textContent = 'From ' + a.hrRef.basis;
        zoneBars(hBox, a.hrZones, a.hrRef.lows, a.hrRef.names, a.hrRef.ref, 'bpm');
    }
}

function renderActTiles() {
    const { ride: r, analysis: a } = rideState.act;
    const kg = weightFor(r);
    const wkg = (v) => (isNum(v) && isNum(kg) ? (v / kg).toFixed(2) + ' W/kg' : null);
    const tiles = [
        ['Distance', fmtKm(r.distanceM) + ' km'],
        ['Moving time', fmtDuration(r.movingSec), 'Elapsed ' + fmtDuration(r.elapsedSec)],
        ['Elevation', fmtInt(r.ascentM) + ' m'],
        ['Avg speed', isNum(r.avgSpeed) ? (r.avgSpeed * 3.6).toFixed(1) + ' km/h' : '–',
         isNum(r.maxSpeed) ? 'Max ' + (r.maxSpeed * 3.6).toFixed(1) + ' km/h' : null],
        ['Avg power', fmtInt(r.avgPower) + ' W', wkg(r.avgPower)],
        ['Normalized power', fmtInt(r.np) + ' W', wkg(r.np)],
        ['Intensity factor', isNum(a.intensity) ? a.intensity.toFixed(2) : '–', a.ftp ? 'NP / FTP' : 'needs an FTP'],
        ['Training load', isNum(a.tss) ? fmtInt(a.tss) + ' TSS' : '–', a.ftp ? 'FTP ' + a.ftp.watts + ' W, ' + a.ftp.source : null],
        ['Max power', fmtInt(r.maxPower) + ' W', r.spikesFixed ? r.spikesFixed + ' spike' + (r.spikesFixed > 1 ? 's' : '') + ' removed' : null],
        ['Work', fmtInt(r.workKj) + ' kJ'],
        ['Avg heart rate', fmtInt(r.avgHr) + ' bpm', isNum(r.maxHr) ? 'Max ' + r.maxHr + ' bpm' : null],
        ['Pw:HR drift', isNum(a.decoupling) ? a.decoupling.toFixed(1) + ' %' : '–',
         isNum(a.decoupling) ? (a.decoupling < 5 ? 'under 5 %: well paced aerobically' : 'heart rate rose for the same power')
                             : 'needs 20 min of power + HR'],
        ['Avg cadence', fmtInt(r.avgCadence) + ' rpm']
    ];
    $('raActTiles').replaceChildren(...tiles.map(([k, v, sub]) => el('div', { class: 'ra-tile', 'data-tile': k }, [
        el('span', { class: 'ra-tile-label', text: k }),
        el('strong', { text: v }),
        sub ? el('span', { class: 'ra-tile-sub', text: sub }) : null
    ])));
    $('raActStreams').textContent = r.samples.toLocaleString('en-US') + ' samples · channels: ' + r.channels.join(', ') +
        (r.warnings && r.warnings.length ? ' · ⚠ ' + r.warnings.join(' ') : '') +
        ((r.parser || 0) < PARSER_VERSION ? ' · imported with an older version — re-import for current figures' : '');
}

/* Opens a ride: header at once, then streams from IndexedDB. A token makes a
   slow load for an earlier click give way to the latest one. */
async function openRide(id, fromHistory) {
    const r = rideState.rides.find((x) => x.id === id);
    if (!r) return false;
    const token = ++rideState.openToken;
    rideState.current = id;
    $('raTabActivity').disabled = false;
    $('raActName').textContent = r.name;
    $('raActMeta').textContent = [fmtDateTime(r), r.type, r.gear, r.device].filter(Boolean).join(' · ');
    if (!fromHistory) setRoute('ride=' + id);
    showView('activity');

    const streams = await dbStreams(id);
    if (token !== rideState.openToken) return false;
    if (!streams) {
        rideState.act = null;
        $('raActTiles').replaceChildren(el('p', { class: 'ra-empty', text: 'The sample data for this ride is missing. Import it again.' }));
        return false;
    }
    rideState.act = { ride: r, streams, analysis: analyseRide(r, streams), highlight: null, hover: null, chart: null, map: null };
    renderActTiles();
    renderChart();
    renderMap();
    renderBest();
    renderZones();
    return true;
}

function renderAll() {
    renderLibrary();
    renderSettings();
    renderList();
}

function bindUi() {
    for (const tab of document.querySelectorAll('.ra-tab')) {
        tab.addEventListener('click', () => {
            if (tab.disabled) return;
            setRoute(tab.dataset.view === 'activity' && rideState.current ? 'ride=' + rideState.current : '');
            showView(tab.dataset.view);
        });
    }
    $('raBackBtn').addEventListener('click', () => { setRoute(''); showView('activities'); });
    window.addEventListener('popstate', route);

    $('raXAxis').addEventListener('change', renderChart);
    $('raSmooth').addEventListener('change', renderChart);
    /* Charts are drawn at their real pixel width, so redraw when it changes. */
    if (window.ResizeObserver) {
        let lastW = 0;
        let pending = false;
        new ResizeObserver(() => {
            const w = $('raChart').clientWidth;
            if (!rideState.act || pending || w === lastW || !w) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                lastW = $('raChart').clientWidth;
                renderChart();
                renderMap();
            });
        }).observe($('raViewActivity'));
    }

    $('raZipInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
    $('raFitInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
    $('raFolderInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
    $('raCancelBtn').addEventListener('click', () => { rideState.cancel = true; });

    const zone = $('raDropZone');
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        importFiles(e.dataTransfer.files);
    });

    const numberSetting = (id, key) => $(id).addEventListener('change', (e) => {
        const v = e.target.value === '' ? null : Number(e.target.value);
        rideState.settings[key] = isNum(v) && e.target.checkValidity() ? v : null;
        saveSettings();
        renderSettings();
    });
    numberSetting('raWeight', 'weightKg');
    numberSetting('raMaxHr', 'maxHr');
    numberSetting('raLthr', 'lthr');

    $('raWindowForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const err = addWindow($('raWindowInput').value);
        $('raWindowError').textContent = err || '';
        if (!err) $('raWindowInput').value = '';
        renderSettings();
    });

    $('raFtpForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const err = addFtpEntry($('raFtpDate').value, $('raFtpWatts').value, $('raFtpNote').value);
        $('raFtpError').textContent = err || '';
        if (!err) { $('raFtpWatts').value = ''; $('raFtpNote').value = ''; }
        renderSettings();
    });

    for (const id of ['raSearch', 'raFrom', 'raTo', 'raType']) {
        $(id).addEventListener('input', () => { rideState.shown = LIST_PAGE; renderList(); });
    }
    for (const th of $('raTable').tHead.rows[0].cells) {
        th.tabIndex = 0;
        const sortBy = () => {
            const key = th.dataset.sort;
            rideState.sort = rideState.sort.key === key
                ? { key, dir: -rideState.sort.dir }
                : { key, dir: key === 'name' || key === 'type' ? 1 : -1 };
            renderList();
        };
        th.addEventListener('click', sortBy);
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter') sortBy(); });
    }
    $('raMoreBtn').addEventListener('click', () => { rideState.shown += LIST_PAGE; renderList(); });

    $('raClearBtn').addEventListener('click', async () => {
        if (!rideState.rides.length) return;
        if (!confirm('Delete all ' + rideState.rides.length + ' stored rides from this browser? Your settings are kept.')) return;
        await dbClear();
        rideState.rides = [];
        rideState.act = null;
        rideState.current = null;
        setRoute('');
        showView('activities');
        $('raTabActivity').disabled = true;
        renderAll();
    });
}

async function init() {
    rideState.settings = loadSettings();
    bindUi();
    try {
        rideState.rides = await dbAllRides();
    } catch (err) {
        $('raLibrarySummary').textContent = 'Browser storage is unavailable (' + (err.message || err) +
            '). Private windows often block it.';
    }
    renderAll();
    route();
}

rideState.ready = init();
