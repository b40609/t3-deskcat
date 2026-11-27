$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    if (-not (Test-Path (Join-Path $repoRoot "dist\panel.html"))) {
        Write-Host "[1/2] Building frontend dist/..."
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    }
    Write-Host "[2/2] Starting T3 DeskCat Web Edition (official signed node.exe)..."
    & node server/index.mjs
} finally {
    Pop-Location
}
