# BF6 lookup regression tests

Headless-Chrome tests for the dashboard's search **error handling and
sequencing** — the behaviour that decides what stays on screen when a lookup
fails.

## Run

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Run-Bf6Tests.ps1
```

Exits **0** when every assertion passes and **1** otherwise, so it can be wired
into CI unchanged. Must be run as a file, not dot-sourced — failure is signalled
by `throw`.

Options:

| Flag | Effect |
|---|---|
| `-KeepHarness` | Leave `harness.generated.html` on disk to inspect a failure. |
| `-ChromePath` | Skip browser discovery (Chrome and Edge are both probed). |

Requires Chrome or Edge on the machine. No network access is needed.

## Files

| Path | Role |
|---|---|
| `Run-Bf6Tests.ps1` | Builds the harness, runs Chrome, parses and scores results. |
| `harness/fetch-mock.js` | Replaces `window.fetch` before `bf6.js` loads. Read as text, not loaded directly. |
| `harness/assertions.js` | The assertions. Also injected as text. |
| `fixtures/bf6-stats.json` | Recorded `/bf6/stats/` response for `offroad89`. 314 KB raw, ~42 KB in git. |
| `harness.generated.html` | Built on each run, gitignored, deleted afterwards. |

## How it works

`bf6.html` is **not** duplicated. The runner reads it and injects two scripts
around `bf6.js`, so markup changes can never desynchronise the tests:

```
<script>window.__BF6_FIXTURE = …</script>   recorded payload
<script>…fetch-mock…</script>               must precede bf6.js
<script src="../bf6.js?v=N"></script>       the real page script
<script>…assertions…</script>               shares its global scope
```

The assertions write `PASS | name | detail` lines into a `PRE` element the
runner then parses.

Because the mock sits in the same global scope, the tests use bare `loadPlayer`
and `appState`. Note that `appState` is a top-level `const`, so it is reachable
from the injected script but is **not** on `window` — `window.appState` is
undefined.

## What is covered

| Scenario | Expected |
|---|---|
| S0 | The lookup `init()` fires on page load succeeds. |
| S1 | A **404** hides the previous player's stats and clears `showingPlayer`. |
| S2 | A later success brings the results back. |
| S3 | A **transient** failure (network) *keeps* the stats and the notice names whose they are. |
| S4 | A clean lookup clears both the error status and the notice. |
| S5 | A slower, *older* lookup resolving last must not clobber the newer result or re-enable the button. |

S1 and S5 both **fail against the pre-fix revision** (`f9ed356`): 7 assertions
fail, exit code 1. That is the control proving these tests are not vacuous.

## Two PowerShell traps worth knowing

* Inside `@(...)`, the **comma operator binds tighter than `+`**, so
  `'--x=' + $y, '--z'` parses as three elements and hands Chrome a bare argument
  it reads as a second URL target ("Multiple targets are not supported"). Build
  concatenated strings before the array.
* `chrome.exe` is a **GUI-subsystem binary**, so a plain pipeline captures none
  of its stdout. Use `Start-Process -RedirectStandardOutput`.
