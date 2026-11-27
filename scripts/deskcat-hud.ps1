# T3 DeskCat Web Edition — Always-on-top Frameless Floating HUD (Signed powershell.exe + .NET WPF)
# Zero unsigned binaries, zero Task Scheduler. Talks to local node server/index.mjs on port 8765.
param(
    [string]$RenderPreviewPng = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDataDir = Join-Path $env:APPDATA "t3-deskcat"
$settingsPath = Join-Path $appDataDir "settings.json"
$posPath = Join-Path $appDataDir "web-hud-pos.json"
$port = 8765
$baseUrl = "http://127.0.0.1:$port"

# ---- Single-instance guard (skip when rendering a preview PNG)
$mutex = $null
if (-not $RenderPreviewPng) {
    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, "Local\T3DeskCatWebHud", [ref]$createdNew)
    if (-not $createdNew) {
        # Already running: open the full web panel instead of spawning a duplicate HUD
        $openScript = Join-Path $PSScriptRoot "open-web-app.ps1"
        if (Test-Path $openScript) {
            Start-Process -FilePath "powershell.exe" `
                -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$openScript`"" `
                -WindowStyle Hidden
        }
        exit 0
    }
}

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

function Ensure-WebServer {
    if (Test-PortOpen) { return $true }
    Start-Process -FilePath "node" `
        -ArgumentList "server/index.mjs" `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-PortOpen) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

function Open-FullPanel {
    $openScript = Join-Path $PSScriptRoot "open-web-app.ps1"
    if (Test-Path $openScript) {
        Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$openScript`"" `
            -WindowStyle Hidden
    } else {
        Start-Process $baseUrl
    }
}

function Invoke-DeskCatApi([string]$Cmd) {
    $uri = "$baseUrl/api/invoke/$Cmd"
    $req = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method = "POST"
    $req.ContentType = "application/json"
    $req.Timeout = 4000
    $req.ReadWriteTimeout = 4000
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("{}")
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $resp = $req.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $raw = $reader.ReadToEnd()
        $reader.Close()
        return ($raw | ConvertFrom-Json)
    } finally {
        $resp.Close()
    }
}

function Get-Brush([string]$Hex) {
    $bc = New-Object System.Windows.Media.BrushConverter
    $b = $bc.ConvertFromString($Hex)
    $b.Freeze()
    return $b
}

$brushBg      = Get-Brush "#EB14171F"
$brushBorder  = Get-Brush "#2EFFFFFF"
$brushTrack   = Get-Brush "#24FFFFFF"
$brushText    = Get-Brush "#F2F4F8"
$brushMuted   = Get-Brush "#9BA2B1"
$brushGood    = Get-Brush "#34C759"
$brushWarn    = Get-Brush "#FFD15C"
$brushBad     = Get-Brush "#FF851B"
$brushOut     = Get-Brush "#6C7486"
$brushClaude  = Get-Brush "#E07A47"
$brushAg      = Get-Brush "#4F8BFF"
$brushCodex   = Get-Brush "#38C98F"

function Get-ToneBrush([int]$Pct, [int]$WorkTh, [int]$SleepTh) {
    if ($Pct -le 0) { return $brushOut }
    if ($Pct -lt $SleepTh) { return $brushBad }
    if ($Pct -le $WorkTh) { return $brushWarn }
    return $brushGood
}

function Get-ProviderBrush([string]$Prov) {
    switch ($Prov) {
        "claude"      { return $brushClaude }
        "antigravity" { return $brushAg }
        "codex"       { return $brushCodex }
        default       { return $brushMuted }
    }
}

function Get-InitialPosition {
    $wa = [System.Windows.SystemParameters]::WorkArea
    $x = $wa.Right - 208
    $y = $wa.Top + 16
    if (Test-Path $posPath) {
        try {
            $p = Get-Content $posPath -Raw | ConvertFrom-Json
            if ($null -ne $p.x -and $null -ne $p.y) {
                $x = [double]$p.x
                $y = [double]$p.y
            }
        } catch {}
    } elseif (Test-Path $settingsPath) {
        try {
            $s = Get-Content $settingsPath -Raw | ConvertFrom-Json
            if ($null -ne $s.petX -and $null -ne $s.petY) {
                $x = [double]$s.petX
                $y = [double]$s.petY
            }
        } catch {}
    }
    # Clamp onto visible virtual screen
    $vl = [System.Windows.SystemParameters]::VirtualScreenLeft
    $vt = [System.Windows.SystemParameters]::VirtualScreenTop
    $vr = $vl + [System.Windows.SystemParameters]::VirtualScreenWidth
    $vb = $vt + [System.Windows.SystemParameters]::VirtualScreenHeight
    if ($x -lt $vl -or $x -gt ($vr - 80)) { $x = $wa.Right - 208 }
    if ($y -lt $vt -or $y -gt ($vb - 50)) { $y = $wa.Top + 16 }
    return @{ X = $x; Y = $y }
}

function Save-HudPosition([double]$X, [double]$Y) {
    try {
        New-Item -ItemType Directory -Force -Path $appDataDir | Out-Null
        @{ x = [math]::Round($X); y = [math]::Round($Y) } | ConvertTo-Json | Set-Content -Path $posPath -Encoding UTF8
    } catch {}
}

# Ensure web backend is listening
[void](Ensure-WebServer)

# ---- Build WPF Window
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="T3 DeskCat HUD"
        Width="192"
        SizeToContent="Height"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        ResizeMode="NoResize"
        UseLayoutRounding="True"
        SnapsToDevicePixels="True">
    <Border x:Name="Card"
            Margin="4"
            Padding="10,8,10,9"
            CornerRadius="11"
            Background="#EB14171F"
            BorderBrush="#2EFFFFFF"
            BorderThickness="1"
            Cursor="Hand">
        <Border.Effect>
            <DropShadowEffect Color="#000000" BlurRadius="10" ShadowDepth="2" Opacity="0.45"/>
        </Border.Effect>
        <StackPanel x:Name="RowsPanel" Orientation="Vertical"/>
    </Border>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$card = $window.FindName("Card")
$rowsPanel = $window.FindName("RowsPanel")

$pos = Get-InitialPosition
$window.Left = $pos.X
$window.Top = $pos.Y

$script:locked = $false
$script:dragStart = $null
$script:dragOrigin = $null
$script:didDrag = $false

# ---- Context Menu
$ctx = New-Object System.Windows.Controls.ContextMenu

$miOpen = New-Object System.Windows.Controls.MenuItem
$miOpen.Header = "開啟完整面板"
$miOpen.Add_Click({ Open-FullPanel })
[void]$ctx.Items.Add($miOpen)

$miRefresh = New-Object System.Windows.Controls.MenuItem
$miRefresh.Header = "立即重新整理"
$miRefresh.Add_Click({
    try {
        $snap = Invoke-DeskCatApi "refresh_now"
        Update-HudView $snap
    } catch {}
})
[void]$ctx.Items.Add($miRefresh)

$miLock = New-Object System.Windows.Controls.MenuItem
$miLock.Header = "鎖定位置"
$miLock.IsCheckable = $true
$miLock.Add_Click({ $script:locked = $miLock.IsChecked })
[void]$ctx.Items.Add($miLock)

[void]$ctx.Items.Add((New-Object System.Windows.Controls.Separator))

$miQuit = New-Object System.Windows.Controls.MenuItem
$miQuit.Header = "關閉浮動視窗"
$miQuit.Add_Click({ $window.Close() })
[void]$ctx.Items.Add($miQuit)

$card.ContextMenu = $ctx

# ---- Drag vs Click handling
$card.Add_MouseLeftButtonDown({
    param($s, $e)
    $script:didDrag = $false
    $script:dragStart = $window.PointToScreen($e.GetPosition($window))
    $script:dragOrigin = New-Object System.Windows.Point($window.Left, $window.Top)
    $card.CaptureMouse() | Out-Null
})

$card.Add_MouseMove({
    param($s, $e)
    if ($card.IsMouseCaptured -and -not $script:locked -and $null -ne $script:dragStart) {
        $cur = $window.PointToScreen($e.GetPosition($window))
        $dx = $cur.X - $script:dragStart.X
        $dy = $cur.Y - $script:dragStart.Y
        if ([math]::Abs($dx) -ge 4 -or [math]::Abs($dy) -ge 4) {
            $script:didDrag = $true
        }
        if ($script:didDrag) {
            $window.Left = $script:dragOrigin.X + $dx
            $window.Top = $script:dragOrigin.Y + $dy
        }
    }
})

$card.Add_MouseLeftButtonUp({
    param($s, $e)
    if ($card.IsMouseCaptured) {
        $card.ReleaseMouseCapture()
    }
    if ($script:didDrag) {
        Save-HudPosition $window.Left $window.Top
    } else {
        Open-FullPanel
    }
    $script:dragStart = $null
    $script:didDrag = $false
})

function New-HudRow([string]$Provider, [string]$Name, [int]$Pct, [string]$SubText, [int]$WorkTh, [int]$SleepTh, [bool]$IsFirst) {
    $container = New-Object System.Windows.Controls.StackPanel
    $container.Orientation = "Vertical"
    if (-not $IsFirst) {
        $container.Margin = New-Object System.Windows.Thickness(0, 7, 0, 0)
    }

    $top = New-Object System.Windows.Controls.DockPanel
    $top.LastChildFill = $true

    $pctText = New-Object System.Windows.Controls.TextBlock
    $pctText.Text = "$Pct%"
    $pctText.FontFamily = New-Object System.Windows.Media.FontFamily("Segoe UI Semibold")
    $pctText.FontSize = 12
    $pctText.Foreground = Get-ToneBrush $Pct $WorkTh $SleepTh
    $pctText.VerticalAlignment = "Center"
    [System.Windows.Controls.DockPanel]::SetDock($pctText, "Right")
    [void]$top.Children.Add($pctText)

    $leftStack = New-Object System.Windows.Controls.StackPanel
    $leftStack.Orientation = "Horizontal"
    $leftStack.VerticalAlignment = "Center"

    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 7
    $dot.Height = 7
    $dot.Fill = Get-ProviderBrush $Provider
    $dot.Margin = New-Object System.Windows.Thickness(0, 0, 6, 0)
    $dot.VerticalAlignment = "Center"
    [void]$leftStack.Children.Add($dot)

    $nameText = New-Object System.Windows.Controls.TextBlock
    $nameText.Text = $Name
    $nameText.FontFamily = New-Object System.Windows.Media.FontFamily("Segoe UI Semibold")
    $nameText.FontSize = 12
    $nameText.Foreground = $brushText
    $nameText.TextTrimming = "CharacterEllipsis"
    $nameText.MaxWidth = 104
    $nameText.VerticalAlignment = "Center"
    [void]$leftStack.Children.Add($nameText)

    [void]$top.Children.Add($leftStack)
    [void]$container.Children.Add($top)

    # Progress bar
    $barBg = New-Object System.Windows.Controls.Border
    $barBg.Height = 4
    $barBg.CornerRadius = New-Object System.Windows.CornerRadius(2)
    $barBg.Background = $brushTrack
    $barBg.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)

    $clamped = [math]::Max(0, [math]::Min(100, $Pct))
    $barFill = New-Object System.Windows.Controls.Border
    $barFill.Height = 4
    $barFill.CornerRadius = New-Object System.Windows.CornerRadius(2)
    $barFill.Background = Get-ToneBrush $Pct $WorkTh $SleepTh
    $barFill.HorizontalAlignment = "Left"
    $barFill.Width = [math]::Round(162 * ($clamped / 100.0))
    $barBg.Child = $barFill
    [void]$container.Children.Add($barBg)

    if ($SubText) {
        $sub = New-Object System.Windows.Controls.TextBlock
        $sub.Text = $SubText
        $sub.FontFamily = New-Object System.Windows.Media.FontFamily("Segoe UI")
        $sub.FontSize = 10
        $sub.Foreground = $brushMuted
        $sub.Margin = New-Object System.Windows.Thickness(0, 2, 0, 0)
        $sub.TextTrimming = "CharacterEllipsis"
        [void]$container.Children.Add($sub)
    }

    return $container
}

function Update-HudView($snap) {
    $rowsPanel.Children.Clear()
    if (-not $snap) {
        $msg = New-Object System.Windows.Controls.TextBlock
        $msg.Text = "T3 DeskCat 連線中..."
        $msg.FontSize = 11.5
        $msg.Foreground = $brushMuted
        [void]$rowsPanel.Children.Add($msg)
        return
    }

    $workTh = if ($snap.settings.workingThreshold) { [int]$snap.settings.workingThreshold } else { 70 }
    $sleepTh = if ($snap.settings.sleepingThreshold) { [int]$snap.settings.sleepingThreshold } else { 20 }
    $hudCount = if ($snap.settings.hudCount) { [math]::Max(1, [math]::Min(4, [int]$snap.settings.hudCount)) } else { 2 }

    $items = @()
    if ($snap.picks -and $snap.picks.Count -gt 0) {
        foreach ($pk in ($snap.picks | Select-Object -First $hudCount)) {
            $acc = $snap.accounts | Where-Object { $_.id -eq $pk.accountId } | Select-Object -First 1
            $sub = ""
            if ($acc -and $acc.primaryWindows) {
                $parts = @()
                foreach ($w in ($acc.primaryWindows | Where-Object { -not $_.label.Contains(" ") } | Select-Object -First 2)) {
                    $lbl = if ($w.label -eq "Wk") { "週" } else { $w.label }
                    $parts += "$lbl $($w.remainingPercent)%"
                }
                $sub = $parts -join " · "
            }
            $items += @{
                Provider = $pk.provider
                Name     = $pk.accountName
                Pct      = [int]$pk.effectiveRemaining
                Sub      = $sub
            }
        }
    } else {
        foreach ($acc in ($snap.accounts | Where-Object { $_.status -eq "ok" -or $_.status -eq "idle" } | Select-Object -First $hudCount)) {
            $items += @{
                Provider = $acc.provider
                Name     = $acc.name
                Pct      = [int]$acc.effectiveRemaining
                Sub      = ""
            }
        }
    }

    if ($items.Count -eq 0) {
        $msg = New-Object System.Windows.Controls.TextBlock
        $msg.Text = "尚無可用額度資料"
        $msg.FontSize = 11.5
        $msg.Foreground = $brushMuted
        [void]$rowsPanel.Children.Add($msg)
        return
    }

    for ($i = 0; $i -lt $items.Count; $i++) {
        $it = $items[$i]
        $row = New-HudRow $it.Provider $it.Name $it.Pct $it.Sub $workTh $sleepTh ($i -eq 0)
        [void]$rowsPanel.Children.Add($row)
    }

    $card.ToolTip = "T3 DeskCat（左鍵開啟面板 · 拖曳移動 · 右鍵選單）"
}

function Refresh-Once {
    try {
        $snap = Invoke-DeskCatApi "get_snapshot"
        Update-HudView $snap
    } catch {
        Update-HudView $null
    }
}

# Initial paint
Refresh-Once

# Preview render mode for headless visual verification (exits immediately without showing on desktop)
if ($RenderPreviewPng) {
    $card.Measure((New-Object System.Windows.Size(192, [double]::PositiveInfinity)))
    $sz = $card.DesiredSize
    $card.Arrange((New-Object System.Windows.Rect(0, 0, $sz.Width, $sz.Height)))
    $card.UpdateLayout()
    $scale = 2.0
    $pw = [int][math]::Ceiling($sz.Width * $scale)
    $ph = [int][math]::Ceiling($sz.Height * $scale)
    $dpi = [double](96.0 * $scale)
    $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($pw, $ph, $dpi, $dpi, [System.Windows.Media.PixelFormats]::Pbgra32)
    $rtb.Render($card)
    $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
    $outDir = Split-Path -Parent $RenderPreviewPng
    if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    $fs = [System.IO.File]::Open($RenderPreviewPng, [System.IO.FileMode]::Create)
    try { $enc.Save($fs) } finally { $fs.Close() }
    Write-Host "RENDERED_HUD_PNG=$RenderPreviewPng ($($sz.Width)x$($sz.Height))"
    exit 0
}

# Periodic refresh timer (every 15s)
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(15)
$timer.Add_Tick({ Refresh-Once })
$timer.Start()

$window.Add_Closed({
    $timer.Stop()
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
})

[void]$window.ShowDialog()
