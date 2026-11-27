# T3 DeskCat Web Edition — Always-on-top Floating HUD + Adjacent Popup WebView2 Panel
# 100% Microsoft/Node signed runtime (powershell.exe + .NET WPF + signed Microsoft.Web.WebView2 + node.exe).
# Zero unsigned executables, zero Task Scheduler.
param(
    [string]$RenderPreviewPng = "",
    [switch]$SelfTestPanel
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDataDir = Join-Path $env:APPDATA "t3-deskcat"
$settingsPath = Join-Path $appDataDir "settings.json"
$posPath = Join-Path $appDataDir "web-hud-pos.json"
$wv2UserDataDir = Join-Path $env:LOCALAPPDATA "T3 DeskCat\WebView2Hud"
$port = 8765
$baseUrl = "http://127.0.0.1:$port"
$panelUrl = "$baseUrl/panel.html"

# ---- Win32 helper for Windows 11 native rounded corners + DLL search path for WebView2Loader.dll
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DeskCatWin32 {
    [DllImport("dwmapi.dll", PreserveSig = true)]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetDllDirectory(string lpPathName);
    public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWCP_ROUND = 2;
    public static void ApplyDarkRounded(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        int dark = 1;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
        int round = DWMWCP_ROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));
    }
}
"@

function Find-SignedWebView2Dir {
    $candidates = New-Object System.Collections.Generic.List[string]
    # Teams Meeting Add-in (x64, Microsoft-signed)
    $teamsBase = Join-Path $env:LOCALAPPDATA "Microsoft\TeamsMeetingAdd-in"
    if (Test-Path $teamsBase) {
        Get-ChildItem $teamsBase -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates.Add((Join-Path $_.FullName "x64")) }
    }
    # Visual Studio 2022 BuildTools / IDE PrivateAssemblies
    foreach ($ed in @("BuildTools", "Community", "Professional", "Enterprise")) {
        $candidates.Add("C:\Program Files (x86)\Microsoft Visual Studio\2022\$ed\Common7\IDE\PrivateAssemblies")
        $candidates.Add("C:\Program Files\Microsoft Visual Studio\2022\$ed\Common7\IDE\PrivateAssemblies")
    }
    $candidates.Add("C:\Program Files\GIGABYTE\Control Center")

    foreach ($dir in $candidates) {
        if (-not (Test-Path $dir)) { continue }
        $wpf = Join-Path $dir "Microsoft.Web.WebView2.Wpf.dll"
        $core = Join-Path $dir "Microsoft.Web.WebView2.Core.dll"
        if (-not ((Test-Path $wpf) -and (Test-Path $core))) { continue }
        $loader = $null
        foreach ($rel in @("runtimes\win-x64\native\WebView2Loader.dll", "WebView2Loader.dll")) {
            $p = Join-Path $dir $rel
            if (Test-Path $p) { $loader = Split-Path -Parent $p; break }
        }
        if ($loader) {
            return @{ ManagedDir = $dir; NativeDir = $loader }
        }
    }
    return $null
}

$script:wv2Loaded = $false
$wv2Info = Find-SignedWebView2Dir
if ($wv2Info) {
    try {
        [void][DeskCatWin32]::SetDllDirectory($wv2Info.NativeDir)
        $env:PATH = "$($wv2Info.NativeDir);$env:PATH"
        [System.Reflection.Assembly]::LoadFrom((Join-Path $wv2Info.ManagedDir "Microsoft.Web.WebView2.Core.dll")) | Out-Null
        [System.Reflection.Assembly]::LoadFrom((Join-Path $wv2Info.ManagedDir "Microsoft.Web.WebView2.Wpf.dll")) | Out-Null
        $script:wv2Loaded = $true
    } catch {
        $script:wv2Loaded = $false
    }
}

# ---- Single-instance guard + toggle signal event (so double-clicking shortcut toggles the adjacent panel)
$mutex = $null
$toggleEvent = $null
$isTestMode = [bool]$RenderPreviewPng -or [bool]$SelfTestPanel
if (-not $isTestMode) {
    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, "Local\T3DeskCatWebHud", [ref]$createdNew)
    $toggleEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "Local\T3DeskCatWebHudToggle")
    if (-not $createdNew) {
        try { [void]$toggleEvent.Set() } catch {}
        $toggleEvent.Dispose()
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
    $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
    Start-Process -FilePath $conhost `
        -ArgumentList "--headless node server/index.mjs" `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-PortOpen) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

function Open-InBrowser {
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

function Load-UserSettings {
    if (Test-Path $settingsPath) {
        try { return (Get-Content $settingsPath -Raw | ConvertFrom-Json) } catch {}
    }
    return $null
}

function Get-Brush([string]$Hex) {
    $bc = New-Object System.Windows.Media.BrushConverter
    $b = $bc.ConvertFromString($Hex)
    $b.Freeze()
    return $b
}

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

# Ensure local web backend is running
[void](Ensure-WebServer)

# ---- Build Floating HUD Window
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
$script:panelPinned = $false
$script:dragStart = $null
$script:dragOrigin = $null
$script:didDrag = $false
$script:lastPanelToggleUtc = [DateTime]::MinValue
$script:panelWin = $null
$script:webView = $null
$script:wv2InitStarted = $false

# ---- Build Adjacent Popup Panel Window (embedded signed WebView2 — NOT a new browser tab)
$userSettings = Load-UserSettings
$panelW = if ($userSettings -and $userSettings.panelWidth -ge 320 -and $userSettings.panelWidth -le 680) { [double]$userSettings.panelWidth } else { 390.0 }
$panelH = if ($userSettings -and $userSettings.panelHeight -ge 420 -and $userSettings.panelHeight -le 1080) { [double]$userSettings.panelHeight } else { 666.0 }

function Ensure-PopupPanel {
    if ($null -ne $script:panelWin) { return $true }
    if (-not $script:wv2Loaded) { return $false }

    $pw = New-Object System.Windows.Window
    $pw.Title = "T3 DeskCat Panel"
    $pw.Width = $panelW
    $pw.Height = $panelH
    $pw.WindowStyle = [System.Windows.WindowStyle]::None
    $pw.ResizeMode = [System.Windows.ResizeMode]::NoResize
    $pw.Topmost = $true
    $pw.ShowInTaskbar = $false
    $pw.Background = Get-Brush "#FF0E1015"
    $pw.BorderBrush = Get-Brush "#24FFFFFF"
    $pw.BorderThickness = New-Object System.Windows.Thickness(1)
    $pw.UseLayoutRounding = $true
    $pw.SnapsToDevicePixels = $true

    # Zero-chrome: eliminates the ugly 6px Windows DWM top caption strip completely
    $chrome = New-Object System.Windows.Shell.WindowChrome
    $chrome.CaptionHeight = 0
    $chrome.GlassFrameThickness = New-Object System.Windows.Thickness(0)
    $chrome.ResizeBorderThickness = New-Object System.Windows.Thickness(0)
    $chrome.CornerRadius = New-Object System.Windows.CornerRadius(12)
    [System.Windows.Shell.WindowChrome]::SetWindowChrome($pw, $chrome)

    $wv = New-Object Microsoft.Web.WebView2.Wpf.WebView2
    $wv.DefaultBackgroundColor = [System.Drawing.Color]::FromArgb(255, 14, 16, 21)
    $pw.Content = $wv

    $pw.Add_SourceInitialized({
        param($s, $e)
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($s)).Handle
        [DeskCatWin32]::ApplyDarkRounded($hwnd)
    })

    $pw.Add_KeyDown({
        param($s, $e)
        if ($e.Key -eq [System.Windows.Input.Key]::Escape) {
            $s.Hide()
        }
    })

    # Hide when clicking outside (with 300ms startup/toggle guard matching Rust fa86fa2)
    $pw.Add_Deactivated({
        param($s, $e)
        if ($script:panelPinned) { return }
        $elapsedMs = ([DateTime]::UtcNow - $script:lastPanelToggleUtc).TotalMilliseconds
        if ($elapsedMs -lt 300) { return }
        if ($s.IsVisible) { $s.Hide() }
    })

    # Never destroy on Alt+F4/close; hide so next click is instant
    $pw.Add_Closing({
        param($s, $e)
        if (-not $script:appClosing) {
            $e.Cancel = $true
            $s.Hide()
        }
    })

    $script:panelWin = $pw
    $script:webView = $wv
    return $true
}

function Start-WebView2Init([scriptblock]$OnReady) {
    if ($script:wv2InitStarted -or -not $script:webView) { return }
    $script:wv2InitStarted = $true
    New-Item -ItemType Directory -Force -Path $wv2UserDataDir | Out-Null

    $script:wv2Stage = "env"
    $script:wv2EnvTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, $wv2UserDataDir, $null)
    $script:wv2InitTask = $null
    $script:wv2OnReady = $OnReady

    $script:wv2PollTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:wv2PollTimer.Interval = [TimeSpan]::FromMilliseconds(40)
    $script:wv2PollTimer.Add_Tick({
        if ($script:wv2Stage -eq "env") {
            if (-not $script:wv2EnvTask.IsCompleted) { return }
            if ($script:wv2EnvTask.IsFaulted -or -not $script:wv2EnvTask.Result) {
                $script:wv2PollTimer.Stop()
                $script:wv2InitError = if ($script:wv2EnvTask.Exception) { $script:wv2EnvTask.Exception.InnerException.Message } else { "env creation failed" }
                if ($script:wv2OnReady) { & $script:wv2OnReady $false $script:wv2InitError }
                return
            }
            $script:wv2Stage = "core"
            $script:wv2InitTask = $script:webView.EnsureCoreWebView2Async($script:wv2EnvTask.Result)
            return
        }
        if ($script:wv2Stage -eq "core") {
            if (-not $script:wv2InitTask.IsCompleted) { return }
            $script:wv2PollTimer.Stop()
            if ($script:wv2InitTask.IsFaulted) {
                $script:wv2InitError = if ($script:wv2InitTask.Exception) { $script:wv2InitTask.Exception.InnerException.Message } else { "EnsureCoreWebView2Async failed" }
                if ($script:wv2OnReady) { & $script:wv2OnReady $false $script:wv2InitError }
                return
            }
            try {
                $script:webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = $false
                $script:webView.CoreWebView2.Settings.AreStatusBarEnabled = $false
                $script:webView.CoreWebView2.Settings.AreDevToolsEnabled = $false
            } catch {}
            $script:wv2Stage = "ready"
            if ($script:wv2OnReady) { & $script:wv2OnReady $true $null }
            $script:webView.Source = [Uri]$panelUrl
        }
    })
    $script:wv2PollTimer.Start()
}

function Initialize-WebViewIfNeeded {
    Start-WebView2Init $null
}

function Position-PanelNearHud {
    if (-not $script:panelWin) { return }
    $wa = [System.Windows.SystemParameters]::WorkArea
    $gap = 8.0
    $hudLeft = $window.Left
    $hudTop = $window.Top
    $hudW = if ($window.ActualWidth -gt 0) { $window.ActualWidth } else { 192.0 }
    $hudH = if ($window.ActualHeight -gt 0) { $window.ActualHeight } else { 112.0 }
    $pw = $script:panelWin.Width
    $ph = $script:panelWin.Height

    # Match original panel_position_near_pet: prefer below HUD (aligned right/left), else beside HUD, clamped to work area
    $x = $hudLeft + $hudW - $pw
    if ($x -lt $wa.Left + 8) { $x = $hudLeft }
    if ($x + $pw -gt $wa.Right - 8) { $x = $wa.Right - $pw - 8 }
    if ($x -lt $wa.Left + 8) { $x = $wa.Left + 8 }

    $spaceBelow = $wa.Bottom - ($hudTop + $hudH + $gap)
    $spaceAbove = ($hudTop - $gap) - $wa.Top
    if ($spaceBelow -ge $ph) {
        $y = $hudTop + $hudH + $gap
    } elseif ($spaceAbove -ge $ph) {
        $y = $hudTop - $gap - $ph
    } else {
        # Try placing beside HUD so it never overlaps the HUD
        $spaceLeft = ($hudLeft - $gap) - $wa.Left
        $spaceRight = $wa.Right - ($hudLeft + $hudW + $gap)
        if ($spaceLeft -ge $pw) {
            $x = $hudLeft - $gap - $pw
        } elseif ($spaceRight -ge $pw) {
            $x = $hudLeft + $hudW + $gap
        }
        $y = [math]::Max($wa.Top + 8, [math]::Min($hudTop, $wa.Bottom - $ph - 8))
    }

    $script:panelWin.Left = [math]::Round($x)
    $script:panelWin.Top = [math]::Round($y)
}

function Toggle-AdjacentPanel {
    if (-not (Ensure-PopupPanel)) {
        Open-InBrowser
        return
    }
    $script:lastPanelToggleUtc = [DateTime]::UtcNow
    if ($script:panelWin.IsVisible) {
        $script:panelWin.Hide()
        return
    }
    Position-PanelNearHud
    $script:panelWin.Show()
    [void]$script:panelWin.Activate()
    Initialize-WebViewIfNeeded
}

# ---- Self-test mode: verify WebView2 loads http://127.0.0.1:8765/panel.html cleanly (exits immediately)
if ($SelfTestPanel) {
    if (-not $script:wv2Loaded) {
        Write-Error "Signed Microsoft.Web.WebView2.Wpf.dll not found."
        exit 1
    }
    [void](Ensure-PopupPanel)
    $script:panelWin.Left = -32000
    $script:panelWin.Top = -32000
    $script:panelWin.ShowInTaskbar = $false
    $script:panelWin.Opacity = 0
    $script:testDone = $false
    $script:testResult = "TIMEOUT"

    $script:panelWin.Add_Loaded({
        Start-WebView2Init {
            param($ok, $err)
            if (-not $ok) {
                $script:testResult = "INIT_ERR: $err"
                $script:appClosing = $true
                $script:panelWin.Close()
                return
            }
            $script:webView.CoreWebView2.Add_NavigationCompleted({
                param($sender, $navArgs)
                $script:testResult = "NAV_OK=$($navArgs.IsSuccess) STATUS=$($navArgs.WebErrorStatus) URL=$($sender.Source)"
                $script:testDone = $true
                $script:appClosing = $true
                $script:panelWin.Close()
            })
        }
    })

    $timeoutTimer = New-Object System.Windows.Threading.DispatcherTimer
    $timeoutTimer.Interval = [TimeSpan]::FromSeconds(12)
    $timeoutTimer.Add_Tick({
        $timeoutTimer.Stop()
        $script:appClosing = $true
        $script:panelWin.Close()
    })
    $timeoutTimer.Start()
    [void]$script:panelWin.ShowDialog()
    Write-Host "SELFTEST_PANEL: $script:testResult"
    if (-not $script:testDone -or -not $script:testResult.StartsWith("NAV_OK=True")) { exit 1 }
    exit 0
}

# ---- Context Menu
$ctx = New-Object System.Windows.Controls.ContextMenu

$miToggle = New-Object System.Windows.Controls.MenuItem
$miToggle.Header = "開啟 / 收合面板"
$miToggle.Add_Click({ Toggle-AdjacentPanel })
[void]$ctx.Items.Add($miToggle)

$miPin = New-Object System.Windows.Controls.MenuItem
$miPin.Header = "釘選面板（點外面不收合）"
$miPin.IsCheckable = $true
$miPin.Add_Click({ $script:panelPinned = $miPin.IsChecked })
[void]$ctx.Items.Add($miPin)

$miBrowser = New-Object System.Windows.Controls.MenuItem
$miBrowser.Header = "在瀏覽器開啟完整網頁"
$miBrowser.Add_Click({ Open-InBrowser })
[void]$ctx.Items.Add($miBrowser)

[void]$ctx.Items.Add((New-Object System.Windows.Controls.Separator))

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
$miLock.Header = "鎖定浮動位置"
$miLock.IsCheckable = $true
$miLock.Add_Click({ $script:locked = $miLock.IsChecked })
[void]$ctx.Items.Add($miLock)

[void]$ctx.Items.Add((New-Object System.Windows.Controls.Separator))

$miQuit = New-Object System.Windows.Controls.MenuItem
$miQuit.Header = "關閉浮動視窗"
$miQuit.Add_Click({
    $script:appClosing = $true
    if ($script:panelWin) { try { $script:panelWin.Close() } catch {} }
    $window.Close()
})
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
            if ($script:panelWin -and $script:panelWin.IsVisible) {
                Position-PanelNearHud
            }
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
        Toggle-AdjacentPanel
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

    $card.ToolTip = "T3 DeskCat（左鍵彈出面板 · 拖曳移動 · 右鍵選單）"
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

# Preview render mode for headless verification
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

# Poll single-instance toggle signal every 250ms (so double-clicking desktop shortcut toggles the adjacent panel)
$sigTimer = New-Object System.Windows.Threading.DispatcherTimer
$sigTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$sigTimer.Add_Tick({
    if ($toggleEvent -and $toggleEvent.WaitOne(0)) {
        Toggle-AdjacentPanel
    }
})
$sigTimer.Start()

$window.Add_Closed({
    $script:appClosing = $true
    $timer.Stop()
    $sigTimer.Stop()
    if ($script:panelWin) { try { $script:panelWin.Close() } catch {} }
    if ($toggleEvent) { try { $toggleEvent.Dispose() } catch {} }
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
})

[void]$window.ShowDialog()
