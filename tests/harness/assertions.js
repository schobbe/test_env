/* BF6 test harness - assertions.
 *
 * Injected by tests/Run-Bf6Tests.ps1 AFTER bf6.js, so it shares the page's
 * global lexical scope: bare `loadPlayer` and `appState` resolve here, while
 * `window.appState` would be undefined (top-level `const` never lands on
 * window). Read as TEXT by the runner and wrapped in <script> tags.
 *
 * Results are appended to a PRE element whose id is TEST_RESULTS, one line per
 * assertion in the form "PASS | name | detail". The runner locates that element
 * and fails the run if any line starts with FAIL. The marker is never written
 * out as a literal tag here - the runner regex-matches it, and a copy inside a
 * comment would make it match this source instead of the real results. */
(function () {
    'use strict';

    var results = [];

    function $(id) { return document.getElementById(id); }
    function txt(id) { var n = $(id); return n ? n.textContent : ''; }
    function disp(id) { var n = $(id); return n ? n.style.display : '<missing>'; }
    function flat(s) { return String(s).replace(/\s+/g, ' ').trim(); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function ok(name, cond, detail) {
        results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name +
            (detail === undefined ? '' : ' | ' + detail));
    }

    /* Polling rather than a fixed sleep: the initial lookup is started by
       init() before this script runs, and --virtual-time-budget makes its
       duration unpredictable. */
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

    function finish() {
        var pre = document.createElement('pre');
        pre.id = 'TEST_RESULTS';
        pre.textContent = results.join('\n');
        document.body.appendChild(pre);
    }

    (async function run() {
        try {
            /* --- S0: the lookup init() fires on page load must succeed --- */
            await waitFor(function () { return disp('bfResults') === 'block'; }, 400);
            ok('S0 initial load renders', disp('bfResults') === 'block', disp('bfResults'));
            ok('S0 showingPlayer set',
                String(appState.showingPlayer).toLowerCase().indexOf('offroad') !== -1,
                String(appState.showingPlayer));

            /* --- S0b: the radar must print absolute values on the chart itself,
                   not leave them only behind a hover on a 3px dot --- */
            var radar = $('bfRadarSvg');
            var radarValues = radar ? radar.querySelectorAll('text.bf-axis-value') : [];
            var radarScores = document.querySelectorAll('#bfRadarLegend .bf-legend-score');

            ok('S0b radar prints a value under every axis',
                radarValues.length === 8, String(radarValues.length) + ' value labels');
            ok('S0b radar viewBox has room for the second line',
                Boolean(radar) && radar.getAttribute('viewBox') === '0 0 320 288',
                radar ? String(radar.getAttribute('viewBox')) : '<no svg>');
            ok('S0b radar legend carries the normalised score',
                radarScores.length === 8, String(radarScores.length) + ' scores');
            ok('S0b radar dots keep an absolute-value hover naming the ceiling',
                Boolean(radar) && /\/100 \(ceiling /.test(radar.innerHTML),
                'no "/100 (ceiling " found in the radar SVG');

            /* --- S1: a definitive 404 must NOT leave the previous player up --- */
            window.__mode = 'error404';
            await loadPlayer('zzz_no_such_player_9x7', 'steam');
            ok('S1 404 hides previous stats', disp('bfResults') === 'none', disp('bfResults'));
            ok('S1 status says player not found',
                txt('bfStatus').indexOf('Player not found') !== -1, flat(txt('bfStatus')));
            ok('S1 stale notice empty', flat(txt('bfStaleNotice')) === '', flat(txt('bfStaleNotice')));
            ok('S1 showingPlayer cleared', appState.showingPlayer === null, String(appState.showingPlayer));

            /* --- S2: recovery must bring the results back --- */
            window.__mode = 'live';
            await loadPlayer('offroad89', 'steam');
            ok('S2 results visible again', disp('bfResults') === 'block', disp('bfResults'));

            /* --- S3: a transient failure must keep the stats and name them --- */
            window.__mode = 'network';
            await loadPlayer('someone_else', 'steam');
            ok('S3 transient failure keeps stats', disp('bfResults') === 'block', disp('bfResults'));
            ok('S3 notice names shown player',
                txt('bfStaleNotice').toLowerCase().indexOf('offroad') !== -1, flat(txt('bfStaleNotice')));
            ok('S3 status explains failure',
                txt('bfStatus').indexOf('reach') !== -1, flat(txt('bfStatus')));
            ok('S3 showingPlayer unchanged',
                String(appState.showingPlayer).toLowerCase().indexOf('offroad') !== -1,
                String(appState.showingPlayer));

            /* --- S4: a clean lookup must clear the error state entirely --- */
            window.__mode = 'live';
            await loadPlayer('offroad89', 'steam');
            ok('S4 notice cleared on success', flat(txt('bfStaleNotice')) === '', flat(txt('bfStaleNotice')));
            ok('S4 status cleared on success', flat(txt('bfStatus')) === '', flat(txt('bfStatus')));

            /* --- S5: the slower, OLDER lookup must not win ---
               pA is issued first (lower token) but forced to 404 and delayed, so
               it resolves last. If the sequencing token were missing it would
               repaint the page with its error and clobber pB's success. */
            window.__mode = 'live';
            window.__delayName = 'zzz_racer_9x7';
            window.__force404Name = 'zzz_racer_9x7';
            var pA = loadPlayer('zzz_racer_9x7', 'steam');
            var pB = loadPlayer('offroad89', 'steam');
            await Promise.all([pA, pB]);
            await sleep(600);

            ok('S5 newest lookup wins', disp('bfResults') === 'block', disp('bfResults'));
            ok('S5 stale failure discarded (no error banner)', flat(txt('bfStatus')) === '', flat(txt('bfStatus')));
            ok('S5 showingPlayer is the newest',
                String(appState.showingPlayer).toLowerCase().indexOf('offroad') !== -1,
                String(appState.showingPlayer));
            ok('S5 search button re-enabled', $('bfSubmitBtn').disabled === false,
                String($('bfSubmitBtn').disabled));
            ok('S5 skeleton hidden', disp('bfSkeleton') === 'none', disp('bfSkeleton'));

            /* --- S6: the head-to-head comparison renders both players --- */
            window.__mode = 'live';
            window.__force404Name = null;
            window.__scaleName = 'vs_rival_9x7';
            window.__scaleAs = 'rival_9x7';
            window.__scaleFactor = 0.5;   /* the rival is deliberately weaker */
            /* Asymmetric class profile, so the union is exercised in both
               directions: the rival has no Recon row and gains a Sniper one. */
            window.__dropClassName = 'Recon';
            window.__addClassName = 'Sniper';

            var vsInput = $('bfCompareInput');
            ok('S6 compare field exists', Boolean(vsInput), 'no #bfCompareInput');
            vsInput.value = 'vs_rival_9x7';

            await loadPlayer('offroad89', 'steam');
            await waitFor(function () {
                return document.querySelectorAll('#bfCompareTable tbody tr').length > 0;
            }, 400);

            var JUDGED = 8;   /* rows above the volume block */
            var rows = document.querySelectorAll('#bfCompareTable tbody tr');
            var winsForRival = 0;
            var volumeWins = 0;
            Array.prototype.forEach.call(rows, function (tr, i) {
                var tds = tr.querySelectorAll('td');
                if (tds[2] && /\bgood\b/.test(tds[2].className)) winsForRival++;
                if (i >= JUDGED && tr.querySelector('td.good')) volumeWins++;
            });

            ok('S6 compare panel is shown', disp('bfComparePanel') !== 'none', disp('bfComparePanel'));
            ok('S6 table has one row per stat', rows.length === 12, String(rows.length) + ' rows');
            ok('S6 radar overlays two shapes on the shared rings',
                document.querySelectorAll('#bfCompareRadarSvg polygon').length === 6,
                String(document.querySelectorAll('#bfCompareRadarSvg polygon').length) + ' polygons (want 4 rings + 2 shapes)');
            ok('S6 radar draws a vertex per axis per player',
                document.querySelectorAll('#bfCompareRadarSvg circle').length === 16,
                String(document.querySelectorAll('#bfCompareRadarSvg circle').length) + ' dots');
            ok('S6 legend names both players',
                /offroad89/.test(txt('bfCompareRadarLegend')) && /rival_9x7/.test(txt('bfCompareRadarLegend')),
                flat(txt('bfCompareRadarLegend')).slice(0, 70));
            ok('S6 volume rows are tagged, not judged',
                document.querySelectorAll('#bfCompareTable .bf-compare-tag').length === 4,
                String(document.querySelectorAll('#bfCompareTable .bf-compare-tag').length) + ' volume tags');
            ok('S6 the stronger player leads every judged row',
                document.querySelectorAll('#bfCompareTable td.good').length === JUDGED && winsForRival === 0,
                document.querySelectorAll('#bfCompareTable td.good').length + ' leaders, ' +
                winsForRival + ' of them handed to the weaker player');
            ok('S6 volume rows are never crowned', volumeWins === 0, volumeWins + ' volume leaders');

            /* --- S8: the per-class comparison --- */
            var classRows = document.querySelectorAll('#bfCompareClasses .bf-compare-classes tbody tr');
            var mixHeads = document.querySelectorAll('#bfCompareClasses .bf-bar-subhead');
            var barsA = document.querySelectorAll('#bfCompareClasses .bf-bar-fill.a');
            var barsB = document.querySelectorAll('#bfCompareClasses .bf-bar-fill.b');
            var absent = document.querySelectorAll('#bfCompareClasses .bf-compare-cell.absent');
            var leaders = document.querySelectorAll('#bfCompareClasses .bf-compare-classes td.good');

            ok('S8 the class table is the union of both class lists',
                classRows.length === 5,
                String(classRows.length) + ' rows (A has 4; the rival drops Recon and gains Sniper)');
            ok('S8 the mix draws one bar per player per class',
                mixHeads.length === 5 && barsA.length === 5 && barsB.length === 5,
                mixHeads.length + ' classes, ' + barsA.length + ' A bars, ' + barsB.length + ' B bars');
            ok('S8 a class only one player has is shown rather than dropped',
                absent.length === 4,
                absent.length + ' absent cells (Recon missing from one player, Sniper from the other)');
            ok('S8 a row containing a dash crowns nobody',
                Array.prototype.every.call(classRows, function (tr) {
                    var missing = tr.querySelectorAll('.bf-compare-cell.absent').length > 0;
                    return !missing || !tr.querySelector('td.good');
                }), 'some row with a dash also carries a leader');
            ok('S8 leaders land on the stronger player',
                leaders.length === 6, leaders.length + ' leader cells');
            ok('S8 the played-but-unscored class renders instead of NaN',
                !/NaN/.test(flat(txt('bfCompareClasses'))) && flat(txt('bfCompareClasses')).length > 0,
                /NaN/.test(flat(txt('bfCompareClasses'))) ? 'NaN found in the class block' : 'no NaN');

            /* --- S7: a bad second name must not disturb the main player --- */
            window.__force404Name = 'zzz_missing_9x7';
            vsInput.value = 'zzz_missing_9x7';
            await loadPlayer('offroad89', 'steam');
            await waitFor(function () {
                return txt('bfComparePanel').indexOf('Could not load') !== -1;
            }, 400);

            ok('S7 the failure is reported inside the comparison panel',
                txt('bfComparePanel').indexOf('Could not load') !== -1,
                flat(txt('bfComparePanel')).slice(0, 70));
            ok('S7 the main player is untouched',
                disp('bfResults') === 'block' && flat(txt('bfStatus')) === '',
                disp('bfResults') + ' / status="' + flat(txt('bfStatus')) + '"');
            window.__force404Name = null;
        } catch (e) {
            results.push('FAIL | harness exception | ' + (e && e.stack ? e.stack : e));
        }
        finish();
    }());
}());
