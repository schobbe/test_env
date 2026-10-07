/* Ride Analytics test harness - assertions.
 *
 * Injected by tests/Run-StravaTests.ps1 AFTER strava.js, so it shares the
 * page's global lexical scope: parseFit, buildRide, importFiles, rideState
 * and friends resolve directly. The fixtures arrive as base64 in
 * window.__RA_FIXTURES and the generator's own numbers in window.__RA_EXPECTED.
 *
 * Results go into a PRE element whose id is TEST_RESULTS, one line per
 * assertion, "PASS | name | detail". As in the BF6 harness, that marker is
 * never written out as a literal tag in this file. */
(function () {
    'use strict';

    var results = [];
    var F = window.__RA_FIXTURES;
    var E = window.__RA_EXPECTED;

    function q(sel) { return document.querySelector(sel); }
    function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

    function ok(name, cond, detail) {
        results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name +
            (detail === undefined ? '' : ' | ' + detail));
        progress('after ' + name);
    }

    /* Where the run got to, for when the dump happens before finish(). */
    function progress(text) {
        var p = document.getElementById('raTestProgress');
        if (!p) {
            p = document.createElement('div');
            p.id = 'raTestProgress';
            document.body.appendChild(p);
        }
        p.textContent = text;
    }
    function near(name, actual, expected, tol) {
        ok(name, typeof actual === 'number' && Math.abs(actual - expected) <= tol,
            'got ' + actual + ', want ' + expected + ' ±' + tol);
    }
    function eq(name, actual, expected) {
        ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
    }
    function waitFor(fn, limit) {
        return new Promise(function (resolve) {
            var n = 0;
            (function tick() {
                var v;
                try { v = fn(); } catch (e) { v = false; }
                if (v || n++ > limit) { resolve(v); return; }
                setTimeout(tick, 50);
            }());
        });
    }
    function throwsLike(name, fn, re) {
        try { fn(); ok(name, false, 'did not throw'); }
        catch (e) { ok(name, e instanceof FitError && re.test(e.message), String(e && e.message)); }
    }

    function bytes(key) {
        var bin = atob(F[key]);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function buf(key) { return bytes(key).buffer; }
    function file(key, name) { return new File([bytes(key)], name); }
    async function gzipFile(key, name) {
        var stream = new Blob([bytes(key)]).stream().pipeThrough(new CompressionStream('gzip'));
        return new File([await new Response(stream).arrayBuffer()], name);
    }
    function textFile(text, name) { return new File([text], name); }

    function finish() {
        var pre = document.createElement('pre');
        pre.id = 'TEST_RESULTS';
        pre.textContent = results.join('\n');
        document.body.appendChild(pre);
    }

    (async function run() {
        try {
            progress('waiting for init');
            await rideState.ready;

            /* --- F1: the sample ride decodes to the generator's numbers --- */
            var R = E.sample_ride;
            var fit = parseFit(buf('ride'));
            eq('F1 record count', fit.records.length, R.records);
            eq('F1 no CRC warning on a clean file', fit.warnings.length, 0);

            var built = buildRide(buf('ride'), null, 'sample_ride.fit');
            var r = built.ride;
            eq('F1 is cycling', built.cycling, true);
            eq('F1 start time', r.startUnix, R.startUnix);
            eq('F1 id from start time', r.id, 'r' + R.startUnix);
            eq('F1 local offset from activity message', r.tzOffsetSec, R.tzOffsetSec);
            eq('F1 elapsed seconds', r.elapsedSec, R.elapsedSec);
            eq('F1 timer seconds (pause excluded)', r.timerSec, R.timerSec);
            eq('F1 moving seconds', r.movingSec, R.movingSec);
            near('F1 avg power', r.avgPower, R.avgPower, 0.01);
            near('F1 normalized power', r.np, R.np, 0.05);
            eq('F1 max power is computed on cleaned power', r.maxPower, R.maxPower);
            eq('F1 spike counted', r.spikesFixed, R.spikesFixed.length);
            eq('F1 dropout seconds counted', r.powerGapSec, R.dropout[1] - R.dropout[0]);

            /* --- P: power cleaning rules --- */
            var cp = function (arr) { return cleanPower(Float32Array.from(arr)); };
            eq('P1 isolated spike replaced by neighbour mean', JSON.stringify(Array.from(cp([280, 1800, 290]).power)), '[280,285,290]');
            eq('P2 a sprint ramps up, so it is kept', cp([300, 1100, 1150, 1120, 300]).fixed.length, 0);
            eq('P3 small jumps kept', cp([100, 250, 100]).fixed.length, 0);
            eq('P4 over the cap with sane neighbours', Array.from(cp([300, 2600, 310]).power)[1], 305);
            ok('P5 over the cap with no sane neighbour becomes a gap',
                Number.isNaN(cp([2600, 2700, 2650]).power[1]), String(Array.from(cp([2600, 2700, 2650]).power)));

            /* --- Z: activity analysis against the generator --- */
            var an = analyseRide(r, built.streams);
            eq('Z1 FTP from the ride', an.ftp && an.ftp.watts, R.deviceFtp);
            var bestOk = Object.keys(R.bestEfforts).every(function (k) {
                var b = an.best.find(function (x) { return x.sec === Number(k); });
                return b && Math.abs(b.watts - R.bestEfforts[k].watts) < 1e-6 && b.start === R.bestEfforts[k].start;
            });
            ok('Z2 best efforts: watts and start second', bestOk,
                JSON.stringify(an.best.map(function (b) { return [b.sec, +b.watts.toFixed(3), b.start]; })));
            eq('Z2 no effort longer than the ride', an.best.some(function (b) { return b.sec === 3600; }), false);
            ok('Z2 the spike is not the best 5 s', an.best[0].watts < 600, String(an.best[0].watts));
            eq('Z3 power zones (s)', JSON.stringify(an.powerZones), JSON.stringify(R.powerZonesSec));
            eq('Z4 HR zones (s)', JSON.stringify(an.hrZones), JSON.stringify(R.hrZonesSec));
            near('Z5 Pw:HR decoupling', an.decoupling, R.decouplingPct, 1e-6);
            near('Z6 intensity factor', an.intensity, R.intensity, 1e-9);
            near('Z7 TSS', an.tss, R.tss, 1e-6);
            near('F1 work kJ', r.workKj, R.workKj, 0.01);
            near('F1 avg HR', r.avgHr, R.avgHr, 0.01);
            eq('F1 max HR', r.maxHr, R.maxHr);
            near('F1 distance', r.distanceM, R.distanceM, 0.5);
            eq('F1 ascent from session', r.ascentM, R.ascentM);
            eq('F1 Garmin FTP', r.deviceFtp, R.deviceFtp);
            eq('F1 weight', r.weightKg, R.weightKg);
            eq('F1 max HR setting', r.maxHrSetting, R.maxHrSetting);
            eq('F1 threshold HR', r.lthr, R.lthr);
            eq('F1 device', r.device, 'Garmin');
            eq('F1 type from sub_sport', r.type, 'Road ride');
            near('F1 first latitude', built.streams.lat[0], R.firstLat, 1e-5);
            eq('F1 spike passed through', built.streams.power[R.spikeIndex], 1850);
            ok('F1 dropout is NaN, not 0',
                [0, 1, 2, 3, 4].every(function (k) { return Number.isNaN(built.streams.power[R.dropout[0] + k]); }),
                String(Array.prototype.slice.call(built.streams.power, R.dropout[0] - 1, R.dropout[1] + 1)));
            eq('F1 pause visible as a time gap', built.streams.t[R.records - 1], R.elapsedSec);

            /* --- F2: the edge-case file --- */
            var X = E.edge_cases;
            var ex = buildRide(buf('edge'), null, 'edge_cases.fit');
            var xr = ex.ride;
            eq('F2 record count', xr.samples, X.records);
            eq('F2 compressed timestamps roll over correctly', ex.streams.t[X.records - 1], X.lastUnix - X.startUnix);
            ok('F2 compressed timestamps strictly increasing',
                Array.prototype.every.call(ex.streams.t, function (v, i, a) { return i === 0 || v === a[i - 1] + 1; }), '');
            eq('F2 start time', xr.startUnix, X.startUnix);
            eq('F2 big-endian power values',
                JSON.stringify(Array.prototype.slice.call(ex.streams.power, 0, 12)), JSON.stringify(X.firstPowers));
            near('F2 legacy altitude field', ex.streams.altitude[0], X.altitudeM, 0.01);
            eq('F2 string field read', xr.device, X.productName);
            eq('F2 cycling from sport message', ex.cycling, true);
            eq('F2 indoor type', xr.type, 'Indoor ride');
            near('F2 summary computed without a session', xr.avgPower, X.avgPower, 0.01);
            near('F2 NP', xr.np, X.np, 0.01);
            near('F2 distance integrated from speed', xr.distanceM, 960, 0.01);
            ok('F2 no GPS channel', xr.channels.indexOf('lat') === -1, xr.channels.join(','));

            /* --- F3: rejection paths --- */
            eq('F3 run is not cycling', buildRide(buf('run'), null, 'run.fit').cycling, false);
            throwsLike('F3 truncated file', function () { parseFit(buf('ride').slice(0, 5000)); }, /truncated/i);
            throwsLike('F3 not a FIT file', function () { parseFit(new Uint8Array(64).buffer); }, /not a fit/i);
            var badCrc = bytes('ride');
            badCrc[badCrc.length - 1] ^= 0xFF;
            var crcFit = parseFit(badCrc.buffer);
            ok('F3 bad CRC warns but still decodes',
                crcFit.warnings.some(function (w) { return /CRC/.test(w); }) && crcFit.records.length === R.records,
                crcFit.warnings.join('; '));

            /* --- C: CSV, including Strava's localised headers --- */
            var en = readActivitiesCsv('Activity ID,Activity Date,Activity Name,Activity Type,Filename\n' +
                '7,"Jan 1, 2026","A, ""b""\nc",Ride,activities/7.fit.gz\n');
            eq('C1 quoted comma, quote and newline', en[0].name, 'A, "b"\nc');
            eq('C1 filename column', en[0].file, 'activities/7.fit.gz');
            var de = readActivitiesCsv('﻿Aktivitäts-ID,Aktivitätsdatum,Name der Aktivität,Aktivitätsart,Beschreibung,Dateiname\r\n' +
                '8,"1. Jan. 2026",Feierabendrunde,Radfahrt,,activities/8.fit.gz\r\n');
            eq('C2 German header: name', de[0].name, 'Feierabendrunde');
            eq('C2 German header: type', de[0].type, 'Radfahrt');
            eq('C2 German header: file', de[0].file, 'activities/8.fit.gz');
            eq('C2 German type counts as cycling', csvSaysCycling(de[0]), true);
            var unknown = readActivitiesCsv('a,b,c,d,e\n9,x,Tour,Ride,activities/9.fit\n');
            eq('C3 unknown headers: name by position', unknown[0].name, 'Tour');
            eq('C3 unknown headers: file by content', unknown[0].file, 'activities/9.fit');

            /* --- I1: importing the export ZIP --- */
            var rep = await importFiles([file('zip', 'export_12345.zip')]);
            var X1 = E.export;
            eq('I1 rides imported', rep.imported, X1.rides);
            eq('I1 run skipped', rep.skipped.notCycling.length, X1.notCycling);
            eq('I1 GPX skipped', rep.skipped.unsupportedFormat.length, X1.unsupportedFormat);
            eq('I1 manual entry skipped', rep.skipped.noFile.length, X1.noFile);
            eq('I1 missing file reported', rep.skipped.missingFile.length, X1.missingFile);
            eq('I1 nothing failed', rep.failed.length, 0);
            eq('I1 stored', rideState.rides.length, 2);
            var stored = rideState.rides.find(function (x) { return x.stravaId === '1001'; });
            eq('I1 name from CSV', stored && stored.name, 'Morning ride, with "quotes"');
            eq('I1 type from CSV', stored && stored.type, 'Ride');
            eq('I1 gear from CSV', stored && stored.gear, 'Canyon Ultimate');
            var streams = await dbStreams(stored.id);
            eq('I1 streams stored as typed arrays', streams && streams.power instanceof Float32Array, true);
            eq('I1 report rendered', qa('#raReport > ul > li').length, 5);

            /* --- L: the list --- */
            var rows = qa('#raTable tbody tr');
            eq('L1 two rows', rows.length, 2);
            eq('L1 newest first', rows[0] && rows[0].children[1].textContent, 'Indoor session');
            ok('L1 footer totals', /2 rides/.test(q('#raTable tfoot').textContent), q('#raTable tfoot').textContent);
            q('#raTable th[data-sort="np"]').click();
            eq('L2 sort by NP, highest first', qa('#raTable tbody tr')[0].children[1].textContent, 'Morning ride, with "quotes"');
            q('#raTable th[data-sort="np"]').click();
            eq('L2 second click reverses', qa('#raTable tbody tr')[0].children[1].textContent, 'Indoor session');
            q('#raFrom').value = '2026-09-13';
            q('#raFrom').dispatchEvent(new Event('input'));
            eq('L3 date filter', qa('#raTable tbody tr').length, 1);
            q('#raFrom').value = '';
            q('#raSearch').value = 'canyon';
            q('#raSearch').dispatchEvent(new Event('input'));
            eq('L4 search matches gear', qa('#raTable tbody tr').length, 1);
            q('#raSearch').value = 'zzz';
            q('#raSearch').dispatchEvent(new Event('input'));
            ok('L5 empty filter result explained', !q('#raEmpty').hidden && /match/.test(q('#raEmpty').textContent), q('#raEmpty').textContent);
            q('#raSearch').value = '';
            q('#raSearch').dispatchEvent(new Event('input'));

            /* --- A: opening a ride --- */
            qa('#raTable tbody tr').find(function (tr) { return /Morning/.test(tr.textContent); }).click();
            ok('A1 activity view shown', !q('#raViewActivity').hidden && q('#raViewActivities').hidden, '');
            eq('A1 activity tab enabled and selected', q('#raTabActivity').getAttribute('aria-selected'), 'true');
            eq('A1 title', q('#raActName').textContent, 'Morning ride, with "quotes"');
            /* Tiles render once the streams are back from IndexedDB. */
            await waitFor(function () { return rideState.act && rideState.act.chart; }, 200);
            ok('A1 NP tile', q('#raActTiles').textContent.indexOf(Math.round(R.np) + ' W') !== -1, q('#raActTiles').textContent);
            ok('A1 local start time shown', /2026-09-12 09:30/.test(q('#raActMeta').textContent), q('#raActMeta').textContent);

            /* --- A2: the step-2 activity view --- */
            var morningId = 'r' + R.startUnix;
            await waitFor(function () { return rideState.act && rideState.act.ride.id === morningId && rideState.act.chart; }, 200);
            eq('A2 route in the URL', location.hash, '#ride=' + morningId);
            var panelsDrawn = qa('#raChart [data-channel]').map(function (g) { return g.getAttribute('data-channel'); });
            eq('A2 one chart panel per channel', panelsDrawn.join(','), 'power,hr,speed,cadence,altitude');
            ok('A2 every panel has a line',
                qa('#raChart .ra-line').every(function (p) { return (p.getAttribute('d') || '').length > 100; }), '');
            ok('A2 IF tile', q('[data-tile="Intensity factor"]').textContent.indexOf(R.intensity.toFixed(2)) !== -1,
                q('[data-tile="Intensity factor"]').textContent);
            ok('A2 TSS tile', q('[data-tile="Training load"]').textContent.indexOf(Math.round(R.tss) + ' TSS') !== -1,
                q('[data-tile="Training load"]').textContent);
            ok('A2 max power tile mentions the spike', /1 spike removed/.test(q('[data-tile="Max power"]').textContent),
                q('[data-tile="Max power"]').textContent);
            ok('A2 decoupling tile', q('[data-tile="Pw:HR drift"]').textContent.indexOf(R.decouplingPct.toFixed(1) + ' %') !== -1,
                q('[data-tile="Pw:HR drift"]').textContent);

            var overlay = q('#raChart .ra-overlay');
            var ob = overlay.getBoundingClientRect();
            overlay.dispatchEvent(new PointerEvent('pointermove', { clientX: ob.left + ob.width / 2, clientY: ob.top + 20, bubbles: true }));
            ok('A3 hover picks a sample near the middle',
                rideState.act.hover > R.records * 0.35 && rideState.act.hover < R.records * 0.65, String(rideState.act.hover));
            ok('A3 readout shows power and HR', /Power\s*\d+\s*W/.test(q('#raReadout').textContent) &&
                /Heart rate\s*\d+\s*bpm/.test(q('#raReadout').textContent), q('#raReadout').textContent);
            eq('A3 crosshair visible', q('#raChart .ra-cross').getAttribute('visibility'), 'visible');
            eq('A3 map marker follows', q('#raMap .ra-map-marker').getAttribute('visibility'), 'visible');
            overlay.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
            eq('A3 leaving hides the crosshair', q('#raChart .ra-cross').getAttribute('visibility'), 'hidden');

            q('#raSmooth').value = '1';
            q('#raSmooth').dispatchEvent(new Event('change'));
            ok('A4 unsmoothed chart still uses cleaned power', chartChannels(rideState.act)[0].values[R.spikeIndex] < 1000,
                String(chartChannels(rideState.act)[0].values[R.spikeIndex]));
            q('#raXAxis').value = 'distance';
            q('#raXAxis').dispatchEvent(new Event('change'));
            eq('A4 distance axis', rideState.act.chart.mode, 'distance');
            near('A4 distance axis ends at the ride distance', rideState.act.chart.x1, R.distanceM / 1000, 0.01);
            q('#raXAxis').value = 'time';
            q('#raXAxis').dispatchEvent(new Event('change'));

            ok('A5 route drawn', (q('#raMap .ra-route').getAttribute('points') || '').split(' ').length > 500, '');
            ok('A5 start and finish marked', Boolean(q('#raMap .ra-map-start')) && Boolean(q('#raMap .ra-map-end')), '');

            var bestRows = qa('#raBest tbody tr');
            eq('A6 best effort rows', bestRows.length, Object.keys(R.bestEfforts).length);
            ok('A6 20 min row', bestRows.some(function (tr) {
                return /^20 min/.test(tr.textContent) && tr.textContent.indexOf(Math.round(R.bestEfforts['1200'].watts) + ' W') !== -1;
            }), bestRows.map(function (tr) { return tr.textContent; }).join(' | '));
            eq('A6 data-quality note', q('#raBestNote').textContent, '1 power spike removed · 5 s without power');
            var row20 = bestRows.find(function (tr) { return tr.dataset.sec === '1200'; });
            row20.dispatchEvent(new MouseEvent('mouseenter'));
            var hlRect = q('#raChart .ra-hl-rect');
            ok('A6 hovering an effort shades it on the chart', Boolean(hlRect) && Number(hlRect.getAttribute('width')) > 10,
                hlRect ? hlRect.getAttribute('width') : 'none');
            ok('A6 the row is marked', row20.classList.contains('on'), row20.className);
            row20.dispatchEvent(new MouseEvent('mouseleave'));
            eq('A6 leaving clears it', qa('#raChart .ra-hl-rect').length, 0);

            eq('A7 seven power zones', qa('#raPowerZones .ra-zone').length, 7);
            eq('A7 seven HR zones', qa('#raHrZones .ra-zone').length, 7);
            eq('A7 Z4 time', q('#raPowerZones [data-zone="4"] .ra-zone-time').textContent, fmtDuration(R.powerZonesSec[3]));
            ok('A7 zone basis named', /FTP 265 W, set on your Garmin/.test(q('#raPowerZoneNote').textContent) &&
                /threshold HR 172/.test(q('#raHrZoneNote').textContent),
                q('#raPowerZoneNote').textContent + ' / ' + q('#raHrZoneNote').textContent);

            /* Indoor ride: no GPS, FTP and threshold HR borrowed from the earlier ride. */
            var indoorId = 'r' + E.edge_cases.startUnix;
            await openRide(indoorId);
            ok('A8 indoor ride says there is no GPS', /No GPS/.test(q('#raMap').textContent), q('#raMap').textContent);
            eq('A8 distance axis available from speed', q('#raXAxis option[value="distance"]').disabled, false);
            ok('A8 FTP falls back to the earlier Garmin value', /Garmin, from 2026-09-12/.test(q('#raPowerZoneNote').textContent),
                q('#raPowerZoneNote').textContent);
            eq('A8 HR zones from the latest threshold HR', qa('#raHrZones .ra-zone').length, 7);

            /* A manual entry wins over the Garmin value. */
            addFtpEntry('2026-09-01', 280, 'test');
            eq('A9 manual FTP wins', ftpForRide(rideState.rides.find(function (x) { return x.id === morningId; })).watts, 280);
            removeFtpEntry('2026-09-01');
            eq('A9 and is gone again', ftpForRide(rideState.rides.find(function (x) { return x.id === morningId; })).watts, 265);

            /* Two quick opens: the later one must win. */
            var pa = openRide(morningId);
            var pb = openRide(indoorId);
            await Promise.all([pa, pb]);
            eq('A10 latest open wins', rideState.act.ride.id, indoorId);
            eq('A10 header matches', q('#raActName').textContent, 'Indoor session');

            /* Browser Back from a ride opened off the list returns to the list. */
            q('#raBackBtn').click();
            await openRide(morningId);
            history.back();
            await waitFor(function () { return !q('#raViewActivities').hidden; }, 100);
            ok('A11 Back returns to the list', !q('#raViewActivities').hidden && q('#raViewActivity').hidden, location.hash);

            var keep = rideState.rides[0].parser;
            rideState.rides[0].parser = 1;
            renderLibrary();
            ok('A12 older imports are flagged', /older version/.test(q('#raLibrarySummary').textContent), q('#raLibrarySummary').textContent);
            rideState.rides[0].parser = keep;
            renderLibrary();
            q('#raBackBtn').click();

            /* --- I2: re-importing never duplicates --- */
            rep = await importFiles([file('zip', 'export_12345.zip')]);
            eq('I2 second import updates', rep.updated, 2);
            eq('I2 nothing new', rep.imported, 0);
            eq('I2 still two rides', rideState.rides.length, 2);

            /* --- I3: loose files --- */
            rep = await importFiles([file('ride', 'Garmin_ride.fit')]);
            eq('I3 loose FIT updates the same ride', rep.updated, 1);
            stored = rideState.rides.find(function (x) { return x.stravaId === '1001'; });
            eq('I3 loose FIT keeps the Strava name', stored && stored.name, 'Morning ride, with "quotes"');
            rep = await importFiles([await gzipFile('edge', '1002.fit.gz')]);
            eq('I3 loose .fit.gz', rep.updated, 1);
            rep = await importFiles([file('run', 'run.fit')]);
            eq('I3 loose run skipped', rep.skipped.notCycling.length, 1);
            rep = await importFiles([textFile('nope', 'broken.fit')]);
            eq('I3 broken file reported, not thrown', rep.failed.length, 1);
            ok('I3 failure shown in red', Boolean(q('#raReport li.bad')), q('#raReport').textContent);

            /* --- I4: the unzipped-folder path (CSV + files picked together) --- */
            var entries = await zipEntries(file('zip', 'x.zip'));
            var csvEntry = entries.find(function (e) { return e.name === 'activities.csv'; });
            var csvText = utf8.decode(await zipRead(file('zip', 'x.zip'), csvEntry));
            rep = await importFiles([textFile(csvText, 'activities.csv'), await gzipFile('ride', '1001.fit.gz')]);
            eq('I4 folder import updates the ride', rep.updated, 1);
            eq('I4 rides listed but not picked are missing', rep.skipped.missingFile.length, 3);
            eq('I4 run listed but not picked counts as not cycling', rep.skipped.notCycling.length, 1);

            /* --- W: power curves --- */
            eq('W0 duration grid matches the generator', JSON.stringify(MMP_DURATIONS), JSON.stringify(E.mmpDurations));
            function curveMatches(actual, want) {
                if (!actual) return 'no curve';
                for (var i = 0; i < want.w.length; i++) {
                    var a = actual.w[i], b = want.w[i];
                    if (b === null ? !Number.isNaN(a) : Math.abs(a - b) > 1e-3) return 'w[' + i + '] ' + a + ' vs ' + b;
                    if (actual.s[i] !== want.s[i]) return 's[' + i + '] ' + actual.s[i] + ' vs ' + want.s[i];
                }
                return '';
            }
            var morning = rideState.rides.find(function (x) { return x.id === 'r' + R.startUnix; });
            var indoor = rideState.rides.find(function (x) { return x.id === 'r' + E.edge_cases.startUnix; });
            var why = curveMatches(morning.curve, R.curve);
            ok('W1 ride curve: watts and start second for all 87 durations', why === '', why);
            why = curveMatches(indoor.curve, E.edge_cases.curve);
            ok('W1 indoor ride curve', why === '', why);

            var both = periodCurve([indoor, morning]);
            var maxOk = true, whoOk = true;
            for (var k = 0; k < MMP_DURATIONS.length; k++) {
                var mw = R.curve.w[k], iw = E.edge_cases.curve.w[k];
                var want = mw === null && iw === null ? null : Math.max(mw === null ? -1 : mw, iw === null ? -1 : iw);
                if (want === null ? !Number.isNaN(both.w[k]) : Math.abs(both.w[k] - want) > 1e-3) maxOk = false;
                if (want !== null && both.ride[k].id !== (mw !== null && mw >= (iw === null ? -1 : iw) ? morning.id : indoor.id)) whoOk = false;
            }
            ok('W2 period curve is the element-wise best', maxOk, '');
            ok('W2 each point names the ride it came from (ties go to the earlier ride)', whoOk, '');

            morning.curve = null;
            await dbPutSummary(morning);
            eq('W3 a ride without a curve is backfilled from its streams', await ensureCurves(), 1);
            why = curveMatches(morning.curve, R.curve);
            ok('W3 backfilled curve is identical', why === '', why);
            var storedMorning = (await dbAllRides()).find(function (x) { return x.id === morning.id; });
            ok('W3 and saved', Boolean(storedMorning.curve) && storedMorning.curve.v === CURVE_VERSION, '');

            rideState.today = '2026-10-07';
            await showPower();
            eq('W4 route', location.hash, '#power');
            ok('W4 power view shown', !q('#raViewPower').hidden && q('#raViewActivities').hidden, '');
            eq('W4 default period is the default window', q('#raCurvePeriod').value, 'last:90');
            ok('W4 summary', /^2 rides with power, 2026-07-10 – 2026-10-07/.test(q('#raCurveSummary').textContent), q('#raCurveSummary').textContent);
            ok('W4 curve drawn', (q('#raCurveChart .ra-curve-cur').getAttribute('d') || '').length > 200, '');
            ok('W4 comparison drawn', Boolean(q('#raCurveChart .ra-curve-cmp')), '');
            var keyRows = qa('#raCurveTable tbody tr');
            eq('W4 key durations', keyRows.map(function (tr) { return tr.children[0].textContent; }).join(','), '5 s,1 min,5 min,20 min,1 h');
            var row20c = keyRows[3];
            eq('W4 20 min best', row20c.children[1].textContent, Math.round(R.bestEfforts['1200'].watts) + ' W');
            ok('W4 20 min names its ride', /Morning ride.*2026-09-12/.test(row20c.children[3].textContent), row20c.children[3].textContent);
            eq('W4 no hour in rides under an hour', keyRows[4].children[1].textContent, '–');

            var ov = q('#raCurveChart .ra-overlay');
            var ovb = ov.getBoundingClientRect();
            ov.dispatchEvent(new PointerEvent('pointermove', { clientX: ovb.left + ovb.width * 0.6, clientY: ovb.top + 10, bubbles: true }));
            ok('W5 hover readout names value and ride', /\d+ W · (Morning ride|Indoor session)/.test(q('#raCurveReadout').textContent),
                q('#raCurveReadout').textContent);

            q('#raCurveFrom').value = '2026-09-13';
            q('#raCurveTo').value = '2026-09-13';
            q('#raCurvePeriod').value = 'custom';
            q('#raCurveCompare').value = 'previous';
            q('#raCurvePeriod').dispatchEvent(new Event('change'));
            ok('W6 custom range', !q('#raCurveCustom').hidden && /^1 ride with power, 2026-09-13 – 2026-09-13/.test(q('#raCurveSummary').textContent),
                q('#raCurveSummary').textContent);
            ok('W6 previous period is the day before', /2026-09-12 – 2026-09-12/.test(q('#raCurveLegend').textContent), q('#raCurveLegend').textContent);
            var row1m = qa('#raCurveTable tbody tr')[1];
            var wantDelta = Math.round(E.edge_cases.curve.w[MMP_DURATIONS.indexOf(60)] - R.curve.w[MMP_DURATIONS.indexOf(60)]);
            eq('W6 delta against the previous period', row1m.children[5].textContent, (wantDelta > 0 ? '+' : '') + wantDelta + ' W');

            q('#raCurvePeriod').value = 'lastyear';
            q('#raCurvePeriod').dispatchEvent(new Event('change'));
            ok('W7 empty period explained', /No rides with power/.test(q('#raCurveChart').textContent), q('#raCurveChart').textContent);

            q('#raCurvePeriod').value = 'all';
            q('#raCurveCompare').value = 'best';
            q('#raCurveUnits').value = 'wkg';
            q('#raCurvePeriod').dispatchEvent(new Event('change'));
            eq('W8 W/kg axis', q('#raCurveChart .ra-panel-label').textContent, 'W/kg');
            q('#raCurveUnits').value = 'w';
            q('#raCurveUnits').dispatchEvent(new Event('change'));

            await openFromCurve(MMP_DURATIONS.indexOf(1200));
            eq('W9 clicking a point opens its ride', rideState.act && rideState.act.ride.id, morning.id);
            eq('W9 with that effort shaded', JSON.stringify(rideState.act.highlight),
                JSON.stringify({ sec: 1200, start: R.bestEfforts['1200'].start }));
            ok('W9 shading drawn', Boolean(q('#raChart .ra-hl-rect')), '');
            history.back();
            await waitFor(function () { return !q('#raViewPower').hidden; }, 100);
            ok('W9 Back returns to the power view', !q('#raViewPower').hidden && location.hash === '#power', location.hash);

            await openRide(morning.id);
            eq('W10 exclude button shown for a ride with power', q('#raExcludeBtn').hidden, false);
            q('#raExcludeBtn').click();
            eq('W10 pressed', q('#raExcludeBtn').getAttribute('aria-pressed'), 'true');
            ok('W10 persisted', loadSettings().excluded.indexOf(morning.id) !== -1, JSON.stringify(loadSettings().excluded));
            await showPower();
            ok('W10 excluded ride leaves the curve', /^1 ride with power.*1 excluded/.test(q('#raCurveSummary').textContent),
                q('#raCurveSummary').textContent);
            ok('W10 and is listed', !q('#raExcluded').hidden && /Morning ride/.test(q('#raExcluded').textContent), '');
            q('#raExcluded [data-include]').click();
            ok('W10 including it again restores it', /^2 rides with power/.test(q('#raCurveSummary').textContent) && q('#raExcluded').hidden,
                q('#raCurveSummary').textContent);

            eq('W11 durations read naturally', [5, 75, 1200, 4500, 7200].map(fmtSpan).join(' | '), '5 s | 1:15 min | 20 min | 1 h 15 min | 2 h');
            q('#raBackBtn').click();

            /* --- S: settings --- */
            var s = rideState.settings;
            eq('S1 default window', s.defaultWindow, 90);
            eq('S1 window list', JSON.stringify(s.windows), '[90]');
            eq('S2 add custom window', addWindow(60), null);
            ok('S2 duplicate rejected', /already/.test(addWindow('60') || ''), '');
            ok('S2 too short rejected', /between/.test(addWindow(5) || ''), '');
            ok('S2 non-number rejected', /between/.test(addWindow('abc') || ''), '');
            ok('S2 fraction rejected', /between/.test(addWindow(45.5) || ''), '');
            eq('S2 list sorted', JSON.stringify(rideState.settings.windows), '[60,90]');
            setDefaultWindow(60);
            removeWindow(60);
            eq('S3 default cannot be removed', JSON.stringify(rideState.settings.windows), '[60,90]');
            setDefaultWindow(90);
            removeWindow(60);
            eq('S3 others can', JSON.stringify(rideState.settings.windows), '[90]');
            addWindow(180);
            eq('S4 persisted', JSON.stringify(loadSettings().windows), '[90,180]');
            renderSettings();
            eq('S4 chips rendered', qa('#raWindowChips .ra-chip').length, 2);
            q('#raWindowInput').value = '3';
            q('#raWindowForm').dispatchEvent(new Event('submit', { cancelable: true }));
            ok('S4 form shows the error', /between/.test(q('#raWindowError').textContent), q('#raWindowError').textContent);

            eq('S5 FTP entry added', addFtpEntry('2026-01-10', 270, 'lab'), null);
            eq('S5 same date replaces', addFtpEntry('2026-01-10', 275, ''), null);
            eq('S5 one entry', rideState.settings.ftpEntries.length, 1);
            eq('S5 replaced value', rideState.settings.ftpEntries[0].watts, 275);
            ok('S5 implausible watts rejected', /between/.test(addFtpEntry('2026-02-01', 2000, '') || ''), '');
            ok('S5 missing date rejected', /date/i.test(addFtpEntry('', 250, '') || ''), '');
            eq('S5 persisted', loadSettings().ftpEntries[0].watts, 275);

            var hist = deviceFtpHistory(rideState.rides);
            eq('S6 Garmin FTP history', JSON.stringify(hist.map(function (h) { return [h.date, h.watts]; })), '[["2026-09-12",265]]');
            renderSettings();
            ok('S6 Garmin FTP rendered', /265 W/.test(q('#raFtpDevice').textContent), q('#raFtpDevice').textContent);
            eq('S6 device weight as placeholder', q('#raWeight').placeholder, 'Garmin: 72.5');

            localStorage.setItem(SETTINGS_KEY, '{not json');
            eq('S7 corrupt settings fall back to defaults', loadSettings().defaultWindow, 90);
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({ windows: [3, 1000, 120], defaultWindow: 3 }));
            var cleaned = loadSettings();
            eq('S7 out-of-range windows dropped', JSON.stringify(cleaned.windows), '[120]');
            eq('S7 default falls back to a valid window', cleaned.defaultWindow, 120);

            /* --- D: storage survives a reload of the list --- */
            var again = await dbAllRides();
            eq('D1 rides read back from IndexedDB', again.length, 2);
            await dbClear();
            eq('D2 clear empties storage', (await dbAllRides()).length, 0);
        } catch (e) {
            ok('harness exception', false, String(e && e.stack || e).replace(/\n/g, ' / '));
        }
        finish();
    }());
}());
