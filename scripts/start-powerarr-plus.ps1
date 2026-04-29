param(
    [string]$Bind = "127.0.0.1",
    [int]$Port = 17896,
    [string]$RedisHost = "127.0.0.1",
    [int]$RedisPort = 6379
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$outDir = Join-Path $repoRoot "output"
$healthUrl = "http://${Bind}:$Port/health"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$env:PYTHONPATH = Join-Path $repoRoot "src"
$env:POWERARR_PLUS_BIND = $Bind
$env:POWERARR_PLUS_PORT = "$Port"
$env:POWERARR_PLUS_REDIS_HOST = $RedisHost
$env:POWERARR_PLUS_REDIS_PORT = "$RedisPort"

$isRunning = $false
try {
    $health = curl.exe -sS --max-time 2 $healthUrl
    if ($LASTEXITCODE -eq 0 -and $health) {
        $isRunning = $true
    }
} catch {
    $isRunning = $false
}

if ($isRunning) {
    Write-Output "Already running: $healthUrl"
    Write-Output $health
    exit 0
}

Start-Process `
    -WindowStyle Hidden `
    -FilePath python `
    -WorkingDirectory $repoRoot `
    -ArgumentList @("-m", "powerarr_plus.seen_filter_service") `
    -RedirectStandardOutput (Join-Path $outDir "service.out.log") `
    -RedirectStandardError (Join-Path $outDir "service.err.log")

Start-Sleep -Seconds 1

curl.exe -sS --max-time 5 $healthUrl
