$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$port = 8765
$url = "http://127.0.0.1:$port"

function Test-PortOpen {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect("127.0.0.1", $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(250, $false)
        if ($ok) { $client.EndConnect($iar) }
        $client.Close()
        return $ok
    } catch {
        return $false
    }
}

if (-not (Test-PortOpen)) {
    Start-Process -FilePath "node" `
        -ArgumentList "server/index.mjs" `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden

    for ($i = 0; $i -lt 25; $i++) {
        if (Test-PortOpen) { break }
        Start-Sleep -Milliseconds 200
    }
}

$edgeCandidates = @(
    "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
    Start-Process -FilePath $edge -ArgumentList "--app=$url"
} else {
    Start-Process $url
}
