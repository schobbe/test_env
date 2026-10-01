<#
.SYNOPSIS
    Regression tests for the BF6 dashboard's lookup error handling.

.DESCRIPTION
    Builds a throwaway copy of bf6.html with a fetch mock and an assertion
    script injected around bf6.js, loads it in headless Chrome, and reports the
    results. No real API call is made - the stats payload comes from
    tests/fixtures/bf6-stats.json.

    The harness is generated at run time rather than committed as a copy of
    bf6.html, so markup changes can never desynchronise the tests.

    Must be invoked as a script, not dot-sourced:
        powershell -NoProfile -File tests\Run-Bf6Tests.ps1
    Failure throws, so PowerShell -File exits 1 and success exits 0.

.PARAMETER KeepHarness
    Leave tests/harness.generated.html on disk for inspection after a failure.

.PARAMETER ChromePath
    Skip browser discovery and use this executable.

.EXAMPLE
    powershell -NoProfile -File tests\Run-Bf6Tests.ps1
#>
[CmdletBinding()]
param(
    [switch]$KeepHarness,
    [string]$ChromePath
)

$ErrorActionPreference = 'Stop'

$testsDir    = $PSScriptRoot
$repoRoot    = Split-Path -Parent $testsDir
$htmlPath    = Join-Path $repoRoot 'bf6.html'
$fixturePath = Join-Path $testsDir 'fixtures\bf6-stats.json'
$mockPath    = Join-Path $testsDir 'harness\fetch-mock.js'
$assertPath  = Join-Path $testsDir 'harness\assertions.js'
$harnessPath = Join-Path $testsDir 'harness.generated.html'

$utf8 = New-Object System.Text.UTF8Encoding($false)

function Resolve-Chrome {
    param([string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "Chrome not found at '$Explicit'." }
        return (Resolve-Path $Explicit).Path
    }
    $known = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($c in $known) { if ($c -and (Test-Path $c)) { return $c } }
    foreach ($name in 'chrome.exe', 'chrome', 'google-chrome', 'chromium', 'msedge.exe', 'msedge') {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    throw 'No Chrome or Edge found. Pass -ChromePath to point at one.'
}

foreach ($required in $htmlPath, $fixturePath, $mockPath, $assertPath) {
    if (-not (Test-Path $required)) { throw "Missing required file: $required" }
}

$chrome = Resolve-Chrome -Explicit $ChromePath
Write-Host "browser : $chrome"

# ---------------------------------------------------------------------------
# Assemble the harness
# ---------------------------------------------------------------------------
$html = [System.IO.File]::ReadAllText($htmlPath, $utf8)

# Match on the version number, not a literal ?v=3, so a future cache-bust bump
# cannot silently disable the injection.
$jsMatch = [regex]::Match($html, '<script src="bf6\.js\?v=(\d+)"></script>')
if (-not $jsMatch.Success) { throw 'Injection point not found: bf6.js <script> tag in bf6.html' }
$cssMatch = [regex]::Match($html, 'href="bf6\.css\?v=(\d+)"')
if (-not $cssMatch.Success) { throw 'Injection point not found: bf6.css <link> tag in bf6.html' }

$version = $jsMatch.Groups[1].Value
$html = $html.Replace($cssMatch.Value, 'href="../bf6.css?v=' + $version + '"')

# Escape "<" so a "</script>" inside the JSON cannot terminate the tag early.
$fixtureLiteral = [System.IO.File]::ReadAllText($fixturePath, $utf8).Trim().Replace('<', '\u003c')
$mockSource   = [System.IO.File]::ReadAllText($mockPath, $utf8)
$assertSource = [System.IO.File]::ReadAllText($assertPath, $utf8)

$beforeBf6 = '<script>window.__BF6_FIXTURE = ' + $fixtureLiteral + ';</script>' + "`r`n" +
             '<script>' + "`r`n" + $mockSource + "`r`n" + '</script>'
$afterBf6  = '<script>' + "`r`n" + $assertSource + "`r`n" + '</script>'

$html = $html.Replace($jsMatch.Value,
        $beforeBf6 + "`r`n" +
        '<script src="../bf6.js?v=' + $version + '"></script>' + "`r`n" +
        $afterBf6)

[System.IO.File]::WriteAllText($harnessPath, $html, $utf8)
Write-Host ('harness : {0} ({1} bytes)' -f $harnessPath, (Get-Item $harnessPath).Length)

# ---------------------------------------------------------------------------
# Run it
# ---------------------------------------------------------------------------
$stamp     = Get-Date -Format 'yyyyMMddHHmmss'
$domPath   = Join-Path $env:TEMP "bf6-tests-$stamp.html"
$errPath   = Join-Path $env:TEMP "bf6-tests-$stamp.err"
$profileDir = Join-Path $env:TEMP "bf6-tests-profile-$stamp"

try {
    # NOTE: build every concatenated string BEFORE the array. Inside @(...) the
    # comma operator binds tighter than +, so '--x=' + $y, '--z' parses as
    # ('--x=', $y, '--z') - which hands Chrome a bare argument it reads as a
    # second URL target and it aborts with "Multiple targets are not supported".
    $uddArg   = '--user-data-dir=' + $profileDir
    $targetArg = 'file:///' + (($harnessPath -replace '\\', '/').TrimStart('/'))

    $chromeArgs = @(
        '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--disable-extensions',
        $uddArg,
        '--virtual-time-budget=180000',
        '--dump-dom',
        $targetArg
    )

    # Start-Process + RedirectStandardOutput is mandatory: chrome.exe is a GUI
    # subsystem binary, so a plain pipeline captures none of its stdout.
    $proc = Start-Process -FilePath $chrome -ArgumentList $chromeArgs `
                          -RedirectStandardOutput $domPath -RedirectStandardError $errPath `
                          -PassThru -Wait

    if (-not (Test-Path $domPath)) { throw "Chrome produced no DOM output (exit $($proc.ExitCode))." }

    $dom = [System.IO.File]::ReadAllText($domPath, $utf8)

    # Take the LAST match and only count real assertion lines: the marker must
    # never be echoed verbatim into the harness source (it used to appear in a
    # comment, which made the regex match the script body instead).
    $all = [regex]::Matches($dom, '<pre id="TEST_RESULTS">([\s\S]*?)</pre>')
    if ($all.Count -eq 0) {
        $hint = if (Test-Path $errPath) { (Get-Content $errPath -Tail 5) -join ' | ' } else { '' }
        throw "Harness did not finish. Chrome exit $($proc.ExitCode). $hint"
    }
    $results = $all[$all.Count - 1].Groups[1].Value

    $lines = @($results -split "`r?`n" | Where-Object { $_ -match '^(PASS|FAIL) \| ' })
    foreach ($line in $lines) { Write-Host $line }

    $failed = @($lines | Where-Object { $_ -like 'FAIL*' })
    $passed = @($lines | Where-Object { $_ -like 'PASS*' })
    Write-Host ''
    Write-Host ('{0} passed, {1} failed, {2} total' -f $passed.Count, $failed.Count, $lines.Count)

    if ($lines.Count -eq 0) { throw 'Harness reported no assertions.' }
    if ($failed.Count -gt 0) { throw "$($failed.Count) assertion(s) failed." }
}
finally {
    if (-not $KeepHarness) { Remove-Item $harnessPath -Force -ErrorAction SilentlyContinue }
    foreach ($f in $domPath, $errPath) {
        if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path $profileDir) { Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host 'All BF6 lookup regression tests passed.' -ForegroundColor Green


