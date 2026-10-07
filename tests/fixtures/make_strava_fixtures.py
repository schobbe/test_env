"""Generate the synthetic Garmin FIT files and Strava export used by the
ride-analytics tests.

Everything is deterministic (seeded noise, fixed timestamps, gzip mtime=0,
fixed ZIP dates), so re-running this script reproduces the committed fixtures
byte for byte. Standard library only:

    python tests/fixtures/make_strava_fixtures.py

Outputs, next to this script:

    strava/sample_ride.fit        ~57 min road ride, 1 Hz, power/HR/cadence/GPS,
                                  one auto-pause, a power spike and a dropout
    strava/edge_cases.fit         small indoor file exercising the awkward
                                  corners of the format (see make_edge_cases)
    strava/sample_run.fit         a short run - must be skipped (cycling only)
    strava/strava_export_sample.zip
                                  mimics Strava's "Download your archive"
    strava/expected.json          values the tests compare the parser against

The summary rules below (timer seconds, moving seconds, NP) are the same ones
strava.js implements. They are restated here independently so the tests are a
real cross-check, not the page grading its own homework.
"""

import gzip
import io
import json
import math
import os
import random
import struct
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'strava')

FIT_EPOCH = 631065600          # 1989-12-31T00:00:00Z in unix seconds
SEMI = 2 ** 31 / 180.0         # degrees -> semicircles

# --------------------------------------------------------------------------
# FIT writer
# --------------------------------------------------------------------------

CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
             0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]


def fit_crc(data, crc=0):
    for byte in data:
        tmp = CRC_TABLE[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ CRC_TABLE[byte & 0xF]
        tmp = CRC_TABLE[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xF]
    return crc


# base type -> (struct code, invalid value)
BASE = {
    0x00: ('B', 0xFF),          # enum
    0x01: ('b', 0x7F),          # sint8
    0x02: ('B', 0xFF),          # uint8
    0x83: ('h', 0x7FFF),        # sint16
    0x84: ('H', 0xFFFF),        # uint16
    0x85: ('i', 0x7FFFFFFF),    # sint32
    0x86: ('I', 0xFFFFFFFF),    # uint32
    0x8C: ('I', 0),             # uint32z
    0x07: (None, None),         # string
    0x0D: ('B', 0xFF),          # byte
}


class FitWriter:
    def __init__(self):
        self.body = bytearray()
        self.defs = {}

    def define(self, local, global_num, fields, big_endian=False, dev_fields=()):
        """fields: [(field_num, size, base_type)], dev_fields: [(num, size, index)]"""
        e = '>' if big_endian else '<'
        header = 0x40 | local | (0x20 if dev_fields else 0)
        self.body += struct.pack('B', header)
        self.body += struct.pack(e + 'BBHB', 0, 1 if big_endian else 0, global_num, len(fields))
        for num, size, base in fields:
            self.body += struct.pack('BBB', num, size, base)
        if dev_fields:
            self.body += struct.pack('B', len(dev_fields))
            for num, size, idx in dev_fields:
                self.body += struct.pack('BBB', num, size, idx)
        self.defs[local] = (e, fields, dev_fields)

    def _values(self, local, values, dev_values):
        e, fields, dev_fields = self.defs[local]
        out = bytearray()
        for (num, size, base), value in zip(fields, values):
            code, invalid = BASE[base]
            if base == 0x07:
                raw = (value or '').encode('utf-8')[:size - 1]
                out += raw + b'\x00' * (size - len(raw))
            elif base == 0x0D and size > 1:
                out += bytes(value) if value is not None else b'\xff' * size
            else:
                out += struct.pack(e + code, invalid if value is None else value)
        for (num, size, idx), value in zip(dev_fields, dev_values):
            out += bytes(value)
        return out

    def data(self, local, values, dev_values=()):
        self.body += struct.pack('B', local) + self._values(local, values, dev_values)

    def data_compressed(self, local, timestamp, values, dev_values=()):
        """Compressed-timestamp header: local type in bits 5-6 (0..3 only)."""
        assert local < 4
        self.body += struct.pack('B', 0x80 | (local << 5) | (timestamp & 0x1F))
        self.body += self._values(local, values, dev_values)

    def finish(self):
        head = struct.pack('<BBHI4s', 14, 0x20, 2132, len(self.body), b'.FIT')
        head += struct.pack('<H', fit_crc(head))
        data = head + bytes(self.body)
        return data + struct.pack('<H', fit_crc(data))


def fit_time(unix):
    return unix - FIT_EPOCH


# --------------------------------------------------------------------------
# Shared summary rules (mirrors strava.js - see module docstring)
# --------------------------------------------------------------------------

MAX_GAP_S = 10

SPIKE_RATIO = 2.0
SPIKE_MIN_JUMP_W = 300
POWER_CAP_W = 2500

BEST_EFFORT_S = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600]
POWER_ZONE_LOWS = [0, 0.56, 0.76, 0.91, 1.06, 1.21, 1.51]      # Coggan, x FTP
HR_ZONE_LOWS = [0, 0.81, 0.90, 0.94, 1.00, 1.03, 1.07]         # Friel, x LTHR


def clean_power(samples):
    """Copies of the samples with single-sample spikes (and anything above the
    cap) replaced by the mean of their neighbours. Returns (samples, fixed)."""
    raw = [s.get('power') for s in samples]
    out, fixed = [dict(s) for s in samples], []
    for i, p in enumerate(raw):
        if p is None:
            continue
        nbs = [raw[j] for j in (i - 1, i + 1)
               if 0 <= j < len(raw) and raw[j] is not None and raw[j] <= POWER_CAP_W]
        if p > POWER_CAP_W:
            out[i]['power'] = sum(nbs) / len(nbs) if nbs else None
            fixed.append(i)
            continue
        if not nbs:
            continue
        nb = max(nbs)
        if p > SPIKE_RATIO * nb and p - nb > SPIKE_MIN_JUMP_W:
            out[i]['power'] = sum(nbs) / len(nbs)
            fixed.append(i)
    return out, fixed


def timer_grid(samples):
    """One entry per timer second: the sample that covers it. Pauses count 1 s."""
    grid = []
    for i, s in enumerate(samples):
        if i == 0:
            grid.append(s)
            continue
        dt = s['t'] - samples[i - 1]['t']
        if dt <= 0:
            continue
        grid.extend([s] * (dt if dt <= MAX_GAP_S else 1))
    return grid


def elapsed_power_grid(samples):
    """Power per elapsed second, pauses as zeros - the grid best efforts use,
    so an effort can never be stitched together across a stop."""
    grid = []
    for i, s in enumerate(samples):
        p = s.get('power') or 0
        if i == 0:
            grid.append(p)
            continue
        dt = s['t'] - samples[i - 1]['t']
        if dt <= 0:
            continue
        if dt <= MAX_GAP_S:
            grid.extend([p] * dt)
        else:
            grid.extend([0] * (dt - 1))
            grid.append(p)
    return grid


def mmp_durations():
    """Mean-maximal power durations: dense where curves bend, sparse where
    they are flat. Mirrors MMP_DURATIONS in strava.js."""
    out = []
    for start, stop, step in [(1, 20, 1), (25, 60, 5), (75, 300, 15), (360, 1200, 60),
                              (1500, 3600, 300), (4500, 21600, 900)]:
        out.extend(range(start, stop + 1, step))
    return out


def power_curve(samples):
    """The ride's mean-maximal curve on MMP durations: watts and start second,
    None where the ride is shorter than the duration."""
    cleaned, _ = clean_power(samples)
    efforts = best_efforts(elapsed_power_grid(cleaned), mmp_durations())
    return {'w': [efforts[str(d)]['watts'] if str(d) in efforts else None for d in mmp_durations()],
            's': [efforts[str(d)]['start'] if str(d) in efforts else -1 for d in mmp_durations()]}


def best_efforts(grid, durations=BEST_EFFORT_S):
    out = {}
    for d in durations:
        if d > len(grid):
            continue
        acc = sum(grid[:d])
        best, start = acc, 0
        for i in range(d, len(grid)):
            acc += grid[i] - grid[i - d]
            if acc > best:
                best, start = acc, i - d + 1
        out[str(d)] = {'watts': best / d, 'start': start}
    return out


def zone_of(ratio, lows):
    k = 0
    for j, low in enumerate(lows):
        if ratio >= low:
            k = j
    return k


def zone_seconds(grid, key, ref, lows):
    secs = [0] * len(lows)
    for s in grid:
        if s.get(key) is not None:
            secs[zone_of(s[key] / ref, lows)] += 1
    return secs


def decoupling(grid):
    """Pw:HR - efficiency (power per beat) of the second half vs the first."""
    both = [(s['power'], s['hr']) for s in grid
            if s.get('power') is not None and s.get('hr') is not None]
    half = len(both) // 2
    a, b = both[:half], both[half:]
    ef1 = sum(p for p, _ in a) / sum(h for _, h in a)
    ef2 = sum(p for p, _ in b) / sum(h for _, h in b)
    return (ef1 - ef2) / ef1 * 100


def analyse(samples, ftp, lthr):
    """Everything the activity view shows beyond the summary."""
    cleaned, fixed = clean_power(samples)
    summary = summarise(samples)
    grid = timer_grid(cleaned)
    intensity = summary['np'] / ftp
    return {
        'spikesFixed': fixed,
        'bestEfforts': best_efforts(elapsed_power_grid(cleaned)),
        'powerZonesSec': zone_seconds(grid, 'power', ftp, POWER_ZONE_LOWS),
        'hrZonesSec': zone_seconds(grid, 'hr', lthr, HR_ZONE_LOWS),
        'decouplingPct': decoupling(grid),
        'intensity': intensity,
        'tss': summary['timerSec'] * summary['np'] * intensity / (ftp * 3600) * 100,
    }


def summarise(samples):
    """samples: dicts with t (unix s) and optional power/hr/cad/speed/dist.
    Power metrics are computed on cleaned power."""
    samples, _ = clean_power(samples)
    grid = timer_grid(samples)

    def moving(s):
        return ((s.get('speed') or 0) > 0.5 or (s.get('power') or 0) > 0
                or (s.get('cad') or 0) > 0)

    power = [s.get('power') or 0 for s in grid]
    np_value = None
    if len(power) >= 30:
        rolled, acc = [], 0.0
        for i, p in enumerate(power):
            acc += p
            if i >= 30:
                acc -= power[i - 30]
            if i >= 29:
                rolled.append(acc / 30.0)
        np_value = (sum(r ** 4 for r in rolled) / len(rolled)) ** 0.25
    hrs = [s['hr'] for s in grid if s.get('hr') is not None]
    dists = [s['dist'] for s in samples if s.get('dist') is not None]
    return {
        'timerSec': len(grid),
        'movingSec': sum(1 for s in grid if moving(s)),
        'elapsedSec': samples[-1]['t'] - samples[0]['t'],
        'avgPower': sum(power) / len(power),
        'maxPower': max(power),
        'np': np_value,
        'avgHr': sum(hrs) / len(hrs) if hrs else None,
        'maxHr': max(hrs) if hrs else None,
        'distanceM': (dists[-1] - dists[0]) if dists else None,
        'workKj': sum(power) / 1000.0,
    }


# --------------------------------------------------------------------------
# sample_ride.fit
# --------------------------------------------------------------------------

RIDE_START = 1789198200      # 2026-09-12T07:30:00Z
RIDE_TZ = 7200               # rider's local offset (CEST), via activity.local_timestamp
RIDE_FTP = 265
RIDE_WEIGHT = 72.5
RIDE_MAX_HR = 188
RIDE_LTHR = 172


def ride_samples():
    rng = random.Random(42)
    blocks = [(600, 150), (1200, 285), (300, 130), ('pause', 180)]
    for _ in range(3):
        blocks += [(60, 420), (120, 120)]
    blocks += [(600, 140)]

    samples, t, hr, dist = [], RIDE_START, 95.0, 0.0
    lat, lng, heading = 49.40, 8.70, 0.0
    for block in blocks:
        if block[0] == 'pause':
            t += block[1]
            continue
        duration, target = block
        for _ in range(duration):
            p = max(0, int(round(target + rng.gauss(0, 12))))
            cad = int(round(88 + rng.gauss(0, 3)))
            if rng.random() < 0.03:          # short coast
                p, cad = 0, 0
            speed = 0.9 * (max(p, 40) / 0.25) ** (1 / 3.0)
            hr += ((92 + 0.25 * target) - hr) / 30.0
            dist += speed
            heading += 0.002
            lat += speed * math.cos(heading) / 111320.0
            lng += speed * math.sin(heading) / (111320.0 * math.cos(math.radians(lat)))
            alt = 300 + 40 * math.sin(dist / 2500.0)
            samples.append({'t': t, 'power': p, 'hr': int(round(hr)), 'cad': cad,
                            'speed': round(speed, 3), 'dist': round(dist, 2),
                            'alt': round(alt, 1), 'lat': lat, 'lng': lng})
            t += 1

    # Data-quality hazards later steps must clean up. The parser must pass
    # them through unchanged: a single-sample spike, and a 5 s sensor dropout
    # where power is written as the invalid sentinel.
    samples[1500]['power'] = 1850
    for i in range(2400, 2405):
        samples[i]['power'] = None
    return samples


def ascent(samples):
    total, ref = 0.0, samples[0]['alt']
    for s in samples:
        if s['alt'] - ref >= 2:
            total += s['alt'] - ref
            ref = s['alt']
        elif s['alt'] < ref:
            ref = s['alt']
    return total


def make_ride():
    samples = ride_samples()
    summary = summarise(samples)
    w = FitWriter()

    w.define(0, 0, [(0, 1, 0x00), (1, 2, 0x84), (2, 2, 0x84), (3, 4, 0x8C), (4, 4, 0x86)])
    w.data(0, [4, 1, 3843, 3412345678, fit_time(RIDE_START)])            # activity, Garmin

    w.define(1, 3, [(4, 2, 0x84), (1, 1, 0x00)])                           # user_profile
    w.data(1, [int(RIDE_WEIGHT * 10), 1])

    w.define(2, 7, [(1, 1, 0x02), (2, 1, 0x02), (3, 2, 0x84)])           # zones_target
    w.data(2, [RIDE_MAX_HR, RIDE_LTHR, RIDE_FTP])

    w.define(3, 21, [(253, 4, 0x86), (0, 1, 0x00), (1, 1, 0x00)])        # event
    w.data(3, [fit_time(RIDE_START), 0, 0])                               # timer start

    w.define(4, 20, [(253, 4, 0x86), (0, 4, 0x85), (1, 4, 0x85), (5, 4, 0x86),
                     (78, 4, 0x86), (73, 4, 0x86), (3, 1, 0x02), (4, 1, 0x02),
                     (7, 2, 0x84)])
    prev = None
    for s in samples:
        if prev is not None and s['t'] - prev > MAX_GAP_S:
            w.data(3, [fit_time(prev), 0, 4])                             # stop_all
            w.data(3, [fit_time(s['t']), 0, 0])                           # start
        w.data(4, [fit_time(s['t']),
                   int(round(s['lat'] * SEMI)), int(round(s['lng'] * SEMI)),
                   int(round(s['dist'] * 100)),
                   int(round((s['alt'] + 500) * 5)),
                   int(round(s['speed'] * 1000)),
                   s['hr'], s['cad'], s['power']])
        prev = s['t']
    end = samples[-1]['t']
    w.data(3, [fit_time(end), 0, 4])

    speeds = [s['speed'] for s in samples]
    cads = [s['cad'] for s in samples if s['cad']]
    w.define(5, 18, [(253, 4, 0x86), (2, 4, 0x86), (5, 1, 0x00), (6, 1, 0x00),
                     (7, 4, 0x86), (8, 4, 0x86), (9, 4, 0x86), (14, 2, 0x84),
                     (15, 2, 0x84), (16, 1, 0x02), (17, 1, 0x02), (18, 1, 0x02),
                     (20, 2, 0x84), (21, 2, 0x84), (22, 2, 0x84), (34, 2, 0x84),
                     (45, 2, 0x84)])
    w.data(5, [fit_time(end), fit_time(RIDE_START), 2, 7,
               (end - RIDE_START) * 1000, summary['timerSec'] * 1000,
               int(round(summary['distanceM'] * 100)),
               int(round(summary['distanceM'] / summary['movingSec'] * 1000)),
               int(round(max(speeds) * 1000)),
               int(round(summary['avgHr'])), summary['maxHr'],
               int(round(sum(cads) / len(cads))),
               int(round(summary['avgPower'])), summary['maxPower'],
               int(round(ascent(samples))), int(round(summary['np'])), RIDE_FTP])

    w.define(6, 34, [(253, 4, 0x86), (5, 4, 0x86), (1, 2, 0x84)])         # activity
    w.data(6, [fit_time(end), fit_time(end) + RIDE_TZ, 1])

    expected = dict(summary)
    expected.update({
        'records': len(samples),
        'startUnix': RIDE_START,
        'tzOffsetSec': RIDE_TZ,
        'deviceFtp': RIDE_FTP,
        'weightKg': RIDE_WEIGHT,
        'maxHrSetting': RIDE_MAX_HR,
        'lthr': RIDE_LTHR,
        'ascentM': int(round(ascent(samples))),
        'firstLat': samples[0]['lat'],
        'spikeIndex': 1500,
        'dropout': [2400, 2405],
    })
    expected.update(analyse(samples, RIDE_FTP, RIDE_LTHR))
    expected['curve'] = power_curve(samples)
    return w.finish(), expected


# --------------------------------------------------------------------------
# edge_cases.fit
# --------------------------------------------------------------------------

EDGE_START = 1789286400      # 2026-09-13T08:00:00Z


def make_edge_cases():
    """An indoor ride written to hit every awkward corner of the format:

    - big-endian definitions throughout
    - local type 0 is defined as file_id, then REDEFINED as record
    - records use compressed-timestamp headers (no field 253), so the 5-bit
      offset rolls over several times across 120 s
    - a string field (file_id.product_name) padded with NULs
    - a byte[3] array field (record.compressed_speed_distance) to skip
    - a developer field on every record, which must be skipped by size
    - legacy altitude/speed fields (2 and 6) instead of the enhanced ones
    - no session message at all, so every summary value must be computed
    """
    w = FitWriter()
    w.define(0, 0, [(0, 1, 0x00), (1, 2, 0x84), (4, 4, 0x86), (8, 16, 0x07)], big_endian=True)
    w.data(0, [4, 1, fit_time(EDGE_START), 'Edge Test'])

    w.define(1, 21, [(253, 4, 0x86), (0, 1, 0x00), (1, 1, 0x00)], big_endian=True)
    w.data(1, [fit_time(EDGE_START), 0, 0])

    w.define(0, 20, [(7, 2, 0x84), (3, 1, 0x02), (4, 1, 0x02), (2, 2, 0x84),
                     (6, 2, 0x84), (8, 3, 0x0D)],
             big_endian=True, dev_fields=[(0, 2, 0)])
    samples = []
    for i in range(120):
        t = EDGE_START + i
        p = 200 + (i % 10) * 5
        s = {'t': t, 'power': p, 'hr': 120 + i // 10, 'cad': 90, 'speed': 8.0}
        samples.append(s)
        w.data_compressed(0, fit_time(t), [p, s['hr'], 90, int((250 + 500) * 5), 8000,
                                           [1, 2, 3]], dev_values=[[0xAB, 0xCD]])

    w.define(2, 12, [(0, 1, 0x00), (1, 1, 0x00)], big_endian=True)       # sport
    w.data(2, [2, 6])                                                     # cycling, indoor

    expected = summarise(samples)
    expected.update({
        'records': len(samples),
        'startUnix': EDGE_START,
        'productName': 'Edge Test',
        'firstPowers': [s['power'] for s in samples[:12]],
        'lastUnix': samples[-1]['t'],
        'altitudeM': 250,
    })
    expected['curve'] = power_curve(samples)
    return w.finish(), expected


# --------------------------------------------------------------------------
# sample_run.fit
# --------------------------------------------------------------------------

RUN_START = 1789371000       # 2026-09-14T07:30:00Z


def make_run():
    w = FitWriter()
    w.define(0, 0, [(0, 1, 0x00), (1, 2, 0x84), (4, 4, 0x86)])
    w.data(0, [4, 1, fit_time(RUN_START)])
    w.define(1, 20, [(253, 4, 0x86), (3, 1, 0x02), (73, 4, 0x86)])
    for i in range(60):
        w.data(1, [fit_time(RUN_START + i), 150, 3200])
    w.define(2, 18, [(253, 4, 0x86), (2, 4, 0x86), (5, 1, 0x00), (7, 4, 0x86)])
    w.data(2, [fit_time(RUN_START + 59), fit_time(RUN_START), 1, 59000])
    return w.finish()


# --------------------------------------------------------------------------
# strava_export_sample.zip
# --------------------------------------------------------------------------

# Column order and the duplicated headers ("Elapsed Time", "Distance") are
# copied from a real export; the page must not depend on header text alone,
# because Strava localises these headers for non-English accounts.
CSV_HEADER = ('Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,'
              'Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,'
              'Activity Private Note,Activity Gear,Filename,Athlete Weight,Bike Weight,'
              'Elapsed Time,Moving Time,Distance,Max Speed')

CSV_ROWS = [
    ['1001', 'Sep 12, 2026, 7:30:00 AM', 'Morning ride, with "quotes"', 'Ride',
     'Two lines\nof description', '3420', '33.1', '170', '80', 'false', '',
     'Canyon Ultimate', 'activities/1001.fit.gz', '72.5', '', '3420', '3240', '33100', '14.1'],
    ['1002', 'Sep 13, 2026, 8:00:00 AM', 'Indoor session', 'Virtual Ride', '', '119', '0.9',
     '131', '5', 'false', '', '', 'activities/1002.fit.gz', '', '', '119', '119', '960', '8.0'],
    ['1003', 'Sep 14, 2026, 7:30:00 AM', 'Evening run', 'Run', '', '59', '0.2', '150', '2',
     'false', '', '', 'activities/1003.fit.gz', '', '', '59', '59', '190', '3.2'],
    ['1004', 'Mar 3, 2019, 5:00:00 PM', 'Old phone ride', 'Ride', '', '1800', '10.0', '', '',
     'false', '', '', 'activities/1004.gpx.gz', '', '', '1800', '1700', '10000', '9.0'],
    ['1005', 'Apr 1, 2020, 9:00:00 AM', 'Manual entry', 'Ride', '', '3600', '30.0', '', '',
     'false', '', '', '', '', '', '3600', '3600', '30000', ''],
    ['1006', 'May 1, 2021, 9:00:00 AM', 'File went missing', 'Ride', '', '3600', '30.0', '', '',
     'false', '', '', 'activities/1006.fit.gz', '', '', '3600', '3600', '30000', ''],
]


def csv_cell(value):
    if any(c in value for c in ',"\n'):
        return '"' + value.replace('"', '""') + '"'
    return value


def make_zip(ride, edge, run):
    csv = CSV_HEADER + '\n' + '\n'.join(','.join(csv_cell(c) for c in row) for row in CSV_ROWS) + '\n'
    buf = io.BytesIO()
    stamp = (2026, 9, 20, 12, 0, 0)
    with zipfile.ZipFile(buf, 'w') as z:
        def add(name, data, method):
            info = zipfile.ZipInfo(name, date_time=stamp)
            info.compress_type = method
            z.writestr(info, data)
        add('profile.csv', 'Athlete ID,First Name\n1,Test\n', zipfile.ZIP_DEFLATED)
        add('activities.csv', csv.encode('utf-8'), zipfile.ZIP_DEFLATED)
        # Both ZIP methods appear in real exports; cover each once.
        add('activities/1001.fit.gz', gzip.compress(ride, mtime=0), zipfile.ZIP_STORED)
        add('activities/1002.fit.gz', gzip.compress(edge, mtime=0), zipfile.ZIP_DEFLATED)
        add('activities/1003.fit.gz', gzip.compress(run, mtime=0), zipfile.ZIP_DEFLATED)
        add('activities/1004.gpx.gz', gzip.compress(b'<gpx></gpx>', mtime=0), zipfile.ZIP_DEFLATED)
        add('media/abc.jpg', b'\xff\xd8\xff\xe0 not really a photo', zipfile.ZIP_STORED)
    return buf.getvalue()


def main():
    os.makedirs(OUT, exist_ok=True)
    ride, ride_expected = make_ride()
    edge, edge_expected = make_edge_cases()
    run = make_run()
    archive = make_zip(ride, edge, run)

    for name, data in [('sample_ride.fit', ride), ('edge_cases.fit', edge),
                       ('sample_run.fit', run), ('strava_export_sample.zip', archive)]:
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(data)
        print('%-28s %8d bytes' % (name, len(data)))

    expected = {'sample_ride': ride_expected, 'edge_cases': edge_expected,
                'mmpDurations': mmp_durations(),
                'export': {'rides': 2, 'notCycling': 1, 'unsupportedFormat': 1,
                           'noFile': 1, 'missingFile': 1}}
    with open(os.path.join(OUT, 'expected.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(expected, f, indent=2, sort_keys=True)
        f.write('\n')
    print('expected.json written')


if __name__ == '__main__':
    main()
