$ErrorActionPreference = "Stop"

function Get-Sha256Hex([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $hashBytes = $sha.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hashBytes) -replace "-", "")
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    Write-Host "[1/5] Stopping any running t3-deskcat process..."
    Get-Process -Name "t3-deskcat" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-Process -Name "t3-deskcat" -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Name "t3-deskcat" -ErrorAction SilentlyContinue) {
        throw "t3-deskcat.exe is still running; close it manually before deploying."
    }

    Write-Host "[2/5] Building frontend + release binary with Tauri custom-protocol..."
    $buildStart = Get-Date
    & npm run build:exe
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build:exe failed with exit code $LASTEXITCODE"
    }

    $srcExe = Join-Path $repoRoot "src-tauri\target\release\t3-deskcat.exe"
    if (-not (Test-Path $srcExe)) {
        throw "Release binary not found at $srcExe"
    }
    $exeItem = Get-Item $srcExe
    if ($exeItem.LastWriteTime -lt $buildStart.AddSeconds(-5)) {
        throw "Release binary timestamp ($($exeItem.LastWriteTime)) is older than build start ($buildStart)."
    }

    Write-Host "[3/5] Verifying built frontend assets are actually embedded in exe..."
    foreach ($asset in @("dist\pet.html", "dist\panel.html", "dist\bubble.html")) {
        if (-not (Test-Path (Join-Path $repoRoot $asset))) {
            throw "Missing built frontend asset: $asset"
        }
    }
    $panelBundle = Get-ChildItem (Join-Path $repoRoot "dist\assets\panel-*.js") | Select-Object -First 1
    $petBundle = Get-ChildItem (Join-Path $repoRoot "dist\assets\pet-*.js") | Select-Object -First 1
    if (-not $panelBundle -or -not $petBundle) {
        throw "Missing dist/assets/panel-*.js or pet-*.js bundle."
    }
    $exeAscii = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($srcExe))
    foreach ($expected in @("assets/$($panelBundle.Name)", "assets/$($petBundle.Name)")) {
        if (-not $exeAscii.Contains($expected)) {
            throw "Embedded asset check FAILED: $expected not found in $srcExe (binary would fail with ERR_CONNECTION_REFUSED)."
        }
    }

    Write-Host "[4/5] Installing to %LOCALAPPDATA%\T3 DeskCat\t3-deskcat.exe..."
    $destDir = Join-Path $env:LOCALAPPDATA "T3 DeskCat"
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    $destExe = Join-Path $destDir "t3-deskcat.exe"
    Copy-Item -Path $srcExe -Destination $destExe -Force

    $srcHash = Get-Sha256Hex $srcExe
    $destHash = Get-Sha256Hex $destExe
    if ($srcHash -ne $destHash) {
        throw "SHA256 mismatch after copy ($srcHash vs $destHash)."
    }

    $running = @(Get-Process -Name "t3-deskcat" -ErrorAction SilentlyContinue).Count
    Write-Host "[5/5] Deployed and verified successfully."
    Write-Host "  Path    : $destExe"
    Write-Host "  Size    : $($exeItem.Length) bytes"
    Write-Host "  Updated : $($exeItem.LastWriteTime)"
    Write-Host "  Bundles : assets/$($panelBundle.Name), assets/$($petBundle.Name)"
    Write-Host "  SHA256  : $destHash"
    Write-Host "  Running : $running (must be 0; launch from physical desktop shortcut)"
} finally {
    Pop-Location
}
