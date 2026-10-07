<#
.SYNOPSIS
    Tests for the Ride Analytics page: FIT decoding, export import, storage
    and settings.

.DESCRIPTION
    Builds a throwaway copy of strava.html with the synthetic fixtures and an
    assertion script injected around strava.js, loads it in headless Chrome,
    and reports the results. Same mechanism as Run-Bf6Tests.ps1.

    The fixtures in tests/fixtures/strava/ are produced by
    tests/fixtures/make_strava_fixtures.py; they are committed, so Python is
    not needed to run the tests.

    Must be invoked as a script, not dot-sourced:
        powershell -NoProfile -File tests\Run-StravaTests.ps1
    Failure throws, so PowerShell -File exits 1 and success exits 0.

.PARAMETER KeepHarness
    Leave tests/strava-harness.generated.html on disk for inspection.

.PARAMETER ChromePath
    Skip browser discovery and use this executable.
#>
[CmdletBinding()]
param(
    [switch]$KeepHarness,
    [string]$ChromePath
)

$ErrorActionPreference = 'Stop'

$testsDir    = $PSScriptRoot
$repoRoot    = Split-Path -Parent $testsDir
$htmlPath    = Join-Path $repoRoot 'strava.html'
$fixtureDir  = Join-Path $testsDir 'fixtures\strava'
$assertPath  = Join-Path $testsDir 'harness\strava-assertions.js'
$harnessPath = Join-Path $testsDir 'strava-harness.generated.html'

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

$binaries = [ordered]@{
    ride = 'sample_ride.fit'
    edge = 'edge_cases.fit'
    run  = 'sample_run.fit'
    zip  = 'strava_export_sample.zip'
}
$expectedPath = Join-Path $fixtureDir 'expected.json'

foreach ($required in @($htmlPath, $assertPath, $expectedPath) + @($binaries.Values | ForEach-Object { Join-Path $fixtureDir $_ })) {
    if (-not (Test-Path $required)) { throw "Missing required file: $required" }
}

$chrome = Resolve-Chrome -Explicit $ChromePath
Write-Host "browser : $chrome"

# ---------------------------------------------------------------------------
# Assemble the harness
# ---------------------------------------------------------------------------
$html = [System.IO.File]::ReadAllText($htmlPath, $utf8)

$jsMatch = [regex]::Match($html, '<script src="strava\.js\?v=(\d+)"></script>')
if (-not $jsMatch.Success) { throw 'Injection point not found: strava.js <script> tag in strava.html' }
$cssMatch = [regex]::Match($html, 'href="strava\.css\?v=(\d+)"')
if (-not $cssMatch.Success) { throw 'Injection point not found: strava.css <link> tag in strava.html' }

$html = $html.Replace($cssMatch.Value, 'href="../strava.css?v=' + $cssMatch.Groups[1].Value + '"')

# Binary fixtures travel as base64: a file:// page cannot fetch its neighbours.
$parts = @()
foreach ($key in $binaries.Keys) {
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $fixtureDir $binaries[$key]))
    $parts += ('"' + $key + '":"' + [Convert]::ToBase64String($bytes) + '"')
}
$expectedLiteral = [System.IO.File]::ReadAllText($expectedPath, $utf8).Trim().Replace('<', '<')
$fixtureScript = '<script>window.__RA_FIXTURES = {' + ($parts -join ',') + '};' + "`r`n" +
                 'window.__RA_EXPECTED = ' + $expectedLiteral + ';</script>'

$assertSource = [System.IO.File]::ReadAllText($assertPath, $utf8)

$html = $html.Replace($jsMatch.Value,
        $fixtureScript + "`r`n" +
        '<script src="../strava.js?v=' + $jsMatch.Groups[1].Value + '"></script>' + "`r`n" +
        '<script>' + "`r`n" + $assertSource + "`r`n" + '</script>')

[System.IO.File]::WriteAllText($harnessPath, $html, $utf8)
Write-Host ('harness : {0} ({1} bytes)' -f $harnessPath, (Get-Item $harnessPath).Length)

# ---------------------------------------------------------------------------
# Run it
#
# NOT --dump-dom with --virtual-time-budget, as the BF6 runner does: virtual
# time only waits for timers and network, so Chrome dumps the DOM while
# IndexedDB and DecompressionStream are still working and the harness never
# gets past init. Instead the page is driven over the DevTools protocol and
# polled in real time until the results element appears.
# ---------------------------------------------------------------------------
$stamp      = Get-Date -Format 'yyyyMMddHHmmss'
$profileDir = Join-Path $env:TEMP "ra-tests-profile-$stamp"
$timeoutSec = 120

$script:cdpId = 0
function Invoke-Cdp {
    param($Socket, [string]$Method, [hashtable]$Params = @{})
    $script:cdpId++
    $id = $script:cdpId
    $json = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 5 -Compress
    $out = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Socket.SendAsync((New-Object System.ArraySegment[byte] -ArgumentList @(, $out)),
        [System.Net.WebSockets.WebSocketMessageType]::Text, $true,
        [System.Threading.CancellationToken]::None).Wait()

    # Replies can arrive in several frames, and events can arrive between
    # them; keep reading until the reply carrying our id turns up.
    $buffer = New-Object byte[] 65536
    while ($true) {
        $ms = New-Object System.IO.MemoryStream
        do {
            $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buffer)
            $r = $Socket.ReceiveAsync($seg, [System.Threading.CancellationToken]::None).Result
            $ms.Write($buffer, 0, $r.Count)
        } while (-not $r.EndOfMessage)
        $msg = [System.Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
        if ($msg.id -eq $id) {
            if ($msg.error) { throw "CDP $Method failed: $($msg.error.message)" }
            return $msg.result
        }
    }
}

$proc = $null
$socket = $null
try {
    # Concatenate BEFORE building the array - see tests/README.md.
    $uddArg    = '--user-data-dir=' + $profileDir
    $targetUrl = 'file:///' + (($harnessPath -replace '\\', '/').TrimStart('/'))

    # Port 0 lets Chrome pick a free port and write it to DevToolsActivePort.
    $chromeArgs = @(
        '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--disable-extensions', '--remote-debugging-port=0',
        $uddArg,
        'about:blank'
    )
    $proc = Start-Process -FilePath $chrome -ArgumentList $chromeArgs -PassThru

    $portFile = Join-Path $profileDir 'DevToolsActivePort'
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $portFile)) {
        if ((Get-Date) -gt $deadline) { throw 'Chrome did not open a DevTools port within 30 s.' }
        Start-Sleep -Milliseconds 100
    }
    $port = $null
    while (-not $port) {
        try { $port = (Get-Content $portFile -ErrorAction Stop | Select-Object -First 1) } catch { }
        if (-not $port) { Start-Sleep -Milliseconds 100 }
    }

    # Assign first: PowerShell 5.1 pipes a JSON array as ONE object, so piping
    # Invoke-RestMethod straight into Where-Object filters the whole array.
    $targets = Invoke-RestMethod "http://127.0.0.1:$port/json/list"
    $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
    if (-not $page) { throw 'No page target found in Chrome.' }

    $socket = New-Object System.Net.WebSockets.ClientWebSocket
    $socket.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [System.Threading.CancellationToken]::None).Wait()

    [void](Invoke-Cdp $socket 'Page.navigate' @{ url = $targetUrl })

    $probe = "(function(){var p=document.getElementById('TEST_RESULTS');" +
             "if(p)return {done:true,text:p.textContent};" +
             "var g=document.getElementById('raTestProgress');" +
             "return {done:false,text:g?g.textContent:''};})()"
    $results = $null
    $last = ''
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $eval = Invoke-Cdp $socket 'Runtime.evaluate' @{ expression = $probe; returnByValue = $true }
        $value = $eval.result.value
        if ($value -and $value.done) { $results = $value.text; break }
        if ($value) { $last = $value.text }
    }
    if ($null -eq $results) { throw "Harness did not finish within $timeoutSec s. Last progress: $last" }

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
    if ($socket) { $socket.Dispose() }
    # Kill the whole tree: renderer and GPU processes outlive a plain Kill().
    if ($proc -and -not $proc.HasExited) { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null }
    if (-not $KeepHarness) { Remove-Item $harnessPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path $profileDir) {
        Start-Sleep -Milliseconds 500
        Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host 'All Ride Analytics tests passed.' -ForegroundColor Green
