/* BF6 test harness - fetch mock.
 *
 * Injected by tests/Run-Bf6Tests.ps1 immediately BEFORE bf6.js is loaded, so it
 * replaces window.fetch before the page makes any request. This file is read as
 * TEXT by the runner; it is never loaded directly, so the runner must wrap it in
 * <script> tags and must supply window.__BF6_FIXTURE first.
 *
 * Controls (all readable/writable from the assertions script):
 *   __mode          'live'     -> stats from the recorded fixture, profile 404s
 *                     'error404' -> every request 404s
 *                     'network'  -> every request rejects with TypeError
 *   __delayName     slow every request carrying name=<value> by 1500 ms
 *   __force404Name  force 404 for every request carrying name=<value>
 *
 * The 404 path matters: apiGet() turns a 404 into a non-retried 'notfound'
 * ApiError, which is what drives the hide-vs-keep decision under test. */
(function () {
    'use strict';

    window.__mode = 'live';
    window.__delayName = null;
    window.__force404Name = null;
    window.__scaleName = null;
    window.__scaleAs = 'rival_9x7';
    window.__scaleFactor = 1;

    /* The core counters the head-to-head judges. matchesPlayed and the
       objective block are deliberately left alone so the per-match rows stay
       comparable between the two players. */
    var SCALED_FIELDS = ['kills', 'deaths', 'accuracy', 'winPercent', 'killDeath',
        'killsPerMinute', 'damagePerMinute', 'headshots', 'score', 'revives'];

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function notFound(message) {
        return {
            status: 404,
            ok: false,
            json: function () { return Promise.resolve({ errors: [message] }); }
        };
    }

    window.fetch = function (url, opts) {
        var u = String(url);

        /* Read the controls at RESPONSE time, not call time, so a test can arm
           them between issuing a slow lookup and issuing the fast one. */
        var wait = (window.__delayName && u.indexOf('name=' + window.__delayName) !== -1) ? 1500 : 0;

        return delay(wait).then(function () {
            if (window.__force404Name && u.indexOf('name=' + window.__force404Name) !== -1) {
                return notFound('No player found');
            }
            if (window.__mode === 'network') {
                throw new TypeError('Failed to fetch (test harness)');
            }
            if (window.__mode === 'error404') {
                return notFound('No player found');
            }
            if (u.indexOf('/bf6/stats/') !== -1) {
                return {
                    status: 200,
                    ok: true,
                    json: function () {
                        /* Deep copy: normaliseStats mutates nothing today, but a
                           shared object would let one scenario poison the next. */
                        var payload = JSON.parse(JSON.stringify(window.__BF6_FIXTURE));

                        /* Serve a genuinely weaker second player, so the leader
                           logic is exercised instead of comparing somebody with
                           their own twin (where every delta would be zero). */
                        if (window.__scaleName && u.indexOf('name=' + window.__scaleName) !== -1) {
                            payload.userName = window.__scaleAs;
                            SCALED_FIELDS.forEach(function (k) {
                                /* Some of these arrive as JSON strings ("19.5"),
                                   not numbers. normaliseStats runs everything
                                   through toNum(), so parse the same way here
                                   or the rival silently keeps A's accuracy,
                                   headshot rate and win rate. */
                                var n = typeof payload[k] === 'number' ? payload[k] : parseFloat(payload[k]);
                                if (isFinite(n)) payload[k] = n * window.__scaleFactor;
                            });
                            if (payload.objective && payload.objective.time &&
                                typeof payload.objective.time.total === 'number') {
                                payload.objective.time.total =
                                    payload.objective.time.total * window.__scaleFactor;
                            }
                        }
                        return Promise.resolve(payload);
                    }
                };
            }
            /* /bf6/profile/ is deliberately absent: the page must render the
               statistics with empty identity panels when it 404s. */
            return notFound('no profile');
        });
    };
})();
