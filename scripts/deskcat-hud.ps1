# T3 DeskCat Web Edition — Native-feel Floating HUD + System Tray + Global Hotkey + Adjacent WebView2 Panel
# 100% signed runtime (Windows powershell.exe + .NET WPF/WinForms + Microsoft.Web.WebView2 + official node.exe).
# Zero unsigned binaries, zero Task Scheduler.
param(
    [string]$RenderPreviewPng = "",
    [switch]$SelfTestPanel
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing, System.Windows.Forms

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDataDir = Join-Path $env:APPDATA "t3-deskcat"
$settingsPath = Join-Path $appDataDir "settings.json"
$posPath = Join-Path $appDataDir "web-hud-pos.json"
$panelGeomPath = Join-Path $appDataDir "web-panel-geom.json"
$wv2UserDataDir = Join-Path $env:LOCALAPPDATA "T3 DeskCat\WebView2Hud"
$iconPath = Join-Path $repoRoot "src-tauri\icons\icon.ico"
$port = 8765
$baseUrl = "http://127.0.0.1:$port"
$panelUrl = "$baseUrl/panel.html?host=desktop"

# ---- Win32 helper: DWM dark/light rounded corners, global hotkeys, drag/resize, DLL dir
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DeskCatWin32 {
    [DllImport("dwmapi.dll", PreserveSig = true)]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetDllDirectory(string lpPathName);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

    public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWCP_ROUND = 2;
    public const int WM_HOTKEY = 0x0312;
    public const int WM_NCLBUTTONDOWN = 0x00A1;
    public const int HTCAPTION = 2;
    public const int WM_SYSCOMMAND = 0x0112;
    public const int SC_SIZE = 0xF000;

    public static void ApplyWindowChrome(IntPtr hwnd, bool dark) {
        if (hwnd == IntPtr.Zero) return;
        int d = dark ? 1 : 0;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref d, sizeof(int));
        int round = DWMWCP_ROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));
    }

    public static void StartDrag(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        ReleaseCapture();
        SendMessage(hwnd, WM_NCLBUTTONDOWN, new IntPtr(HTCAPTION), IntPtr.Zero);
    }

    public static void StartResize(IntPtr hwnd, string dir) {
        if (hwnd == IntPtr.Zero) return;
        int code = 8; // SE default
        switch (dir) {
            case "West":      code = 1; break;
            case "East":      code = 2; break;
            case "North":     code = 3; break;
            case "NorthWest": code = 4; break;
            case "NorthEast": code = 5; break;
            case "South":     code = 6; break;
            case "SouthWest": code = 7; break;
            case "SouthEast": code = 8; break;
        }
        ReleaseCapture();
        SendMessage(hwnd, WM_SYSCOMMAND, new IntPtr(SC_SIZE + code), IntPtr.Zero);
    }
}
"@

function Find-SignedWebView2Dir {
    $candidates = New-Object System.Collections.Generic.List[string]
    $teamsBase = Join-Path $env:LOCALAPPDATA "Microsoft\TeamsMeetingAdd-in"
    if (Test-Path $teamsBase) {
        Get-ChildItem $teamsBase -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates.Add((Join-Path $_.FullName "x64")) }
    }
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
        if ($loader) { return @{ ManagedDir = $dir; NativeDir = $loader } }
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

# ---- Single-instance guard + toggle event
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
        $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
        Start-Process -FilePath $conhost `
            -ArgumentList "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$openScript`"" `
            -WindowStyle Hidden
    } else {
        Start-Process $baseUrl
    }
}

function Invoke-DeskCatApi([string]$Cmd, $Payload = $null) {
    $uri = "$baseUrl/api/invoke/$Cmd"
    $req = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method = "POST"
    $req.ContentType = "application/json"
    $req.Timeout = 4000
    $req.ReadWriteTimeout = 4000
    $json = if ($null -ne $Payload) { $Payload | ConvertTo-Json -Compress -Depth 6 } else { "{}" }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $resp = $req.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $raw = $reader.ReadToEnd()
        $reader.Close()
        if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "null") { return $null }
        return ($raw | ConvertFrom-Json)
    } finally {
        $resp.Close()
    }
}

function Is-SystemDarkTheme {
    try {
        $v = Get-ItemPropertyValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" -Name "AppsUseLightTheme" -ErrorAction Stop
        return ([int]$v -eq 0)
    } catch {
        return $true
    }
}

function Resolve-IsDark($settings) {
    $ap = if ($settings -and $settings.appearance) { [string]$settings.appearance } else { "dark" }
    if ($ap -eq "light") { return $false }
    if ($ap -eq "dark") { return $true }
    return (Is-SystemDarkTheme)
}

function Get-Brush([string]$Hex) {
    $bc = New-Object System.Windows.Media.BrushConverter
    $b = $bc.ConvertFromString($Hex)
    $b.Freeze()
    return $b
}

$palDark = @{
    Bg      = Get-Brush "#EB14171F"
    Border  = Get-Brush "#2EFFFFFF"
    Track   = Get-Brush "#24FFFFFF"
    Text    = Get-Brush "#F2F4F8"
    Muted   = Get-Brush "#9BA2B1"
    PanelBg = Get-Brush "#FF0E1015"
    PanelBd = Get-Brush "#24FFFFFF"
    WvBg    = [System.Drawing.Color]::FromArgb(255, 14, 16, 21)
}
$palLight = @{
    Bg      = Get-Brush "#F2F6F8FC"
    Border  = Get-Brush "#26000000"
    Track   = Get-Brush "#18000000"
    Text    = Get-Brush "#14171F"
    Muted   = Get-Brush "#5D6575"
    PanelBg = Get-Brush "#FFF2F4F8"
    PanelBd = Get-Brush "#26000000"
    WvBg    = [System.Drawing.Color]::FromArgb(255, 242, 244, 248)
}

$brushGood    = Get-Brush "#34C759"
$brushWarn    = Get-Brush "#FFD15C"
$brushWarnLt  = Get-Brush "#B87A00"
$brushBad     = Get-Brush "#FF851B"
$brushBadLt   = Get-Brush "#C85A00"
$brushOut     = Get-Brush "#6C7486"
$brushClaude  = Get-Brush "#E07A47"
$brushAg      = Get-Brush "#4F8BFF"
$brushCodex   = Get-Brush "#38C98F"

function Get-ToneBrush([int]$Pct, [int]$WorkTh, [int]$SleepTh, [bool]$IsDark) {
    if ($Pct -le 0) { return $brushOut }
    if ($Pct -lt $SleepTh) { return $(if ($IsDark) { $brushBad } else { $brushBadLt }) }
    if ($Pct -le $WorkTh) { return $(if ($IsDark) { $brushWarn } else { $brushWarnLt }) }
    return $brushGood
}

function Get-ProviderBrush([string]$Prov) {
    switch ($Prov) {
        "claude"      { return $brushClaude }
        "antigravity" { return $brushAg }
        "codex"       { return $brushCodex }
        default       { return $palDark.Muted }
    }
}

function Convert-DataUrlToImage([string]$DataUrl) {
    if ([string]::IsNullOrWhiteSpace($DataUrl)) { return $null }
    $comma = $DataUrl.IndexOf(",")
    if ($comma -lt 0) { return $null }
    try {
        $bytes = [Convert]::FromBase64String($DataUrl.Substring($comma + 1))
        $ms = New-Object System.IO.MemoryStream(, $bytes)
        $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
        $bmp.BeginInit()
        $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bmp.StreamSource = $ms
        $bmp.EndInit()
        $bmp.Freeze()
        $ms.Dispose()
        return $bmp
    } catch {
        return $null
    }
}

function Parse-Hotkey([string]$Combo) {
    if ([string]::IsNullOrWhiteSpace($Combo)) { return $null }
    $mods = [uint32]0
    $vk = [uint32]0
    foreach ($rawPart in ($Combo -split "\+")) {
        $p = $rawPart.Trim()
        if (-not $p) { continue }
        switch -Regex ($p) {
            "^(Ctrl|Control)$"  { $mods = $mods -bor 0x0002; continue }
            "^Alt$"             { $mods = $mods -bor 0x0001; continue }
            "^Shift$"           { $mods = $mods -bor 0x0004; continue }
            "^(Super|Win|Meta)$"{ $mods = $mods -bor 0x0008; continue }
            "^[A-Za-z]$"        { $vk = [uint32][char]($p.ToUpper()[0]); continue }
            "^[0-9]$"           { $vk = [uint32][char]($p[0]); continue }
            "^F([1-9]|1[0-2])$" { $vk = [uint32](0x6F + [int]$Matches[1]); continue }
            "^Space$"           { $vk = 0x20; continue }
            "^Tab$"             { $vk = 0x09; continue }
            "^Up$"              { $vk = 0x26; continue }
            "^Down$"            { $vk = 0x28; continue }
            "^Left$"            { $vk = 0x25; continue }
            "^Right$"           { $vk = 0x27; continue }
        }
    }
    if ($vk -eq 0) { return $null }
    return @{ Mods = $mods; Vk = $vk }
}

function Get-InitialPosition {
    $wa = [System.Windows.SystemParameters]::WorkArea
    $x = $wa.Right - 210
    $y = $wa.Top + 16
    if (Test-Path $posPath) {
        try {
            $p = Get-Content $posPath -Raw | ConvertFrom-Json
            if ($null -ne $p.x -and $null -ne $p.y) { $x = [double]$p.x; $y = [double]$p.y }
        } catch {}
    } elseif (Test-Path $settingsPath) {
        try {
            $s = Get-Content $settingsPath -Raw | ConvertFrom-Json
            if ($null -ne $s.petX -and $null -ne $s.petY) { $x = [double]$s.petX; $y = [double]$s.petY }
        } catch {}
    }
    $vl = [System.Windows.SystemParameters]::VirtualScreenLeft
    $vt = [System.Windows.SystemParameters]::VirtualScreenTop
    $vr = $vl + [System.Windows.SystemParameters]::VirtualScreenWidth
    $vb = $vt + [System.Windows.SystemParameters]::VirtualScreenHeight
    if ($x -lt $vl -or $x -gt ($vr - 60)) { $x = $wa.Right - 210 }
    if ($y -lt $vt -or $y -gt ($vb - 40)) { $y = $wa.Top + 16 }
    return @{ X = $x; Y = $y }
}

function Save-HudPosition([double]$X, [double]$Y) {
    try {
        New-Item -ItemType Directory -Force -Path $appDataDir | Out-Null
        @{ x = [math]::Round($X); y = [math]::Round($Y) } | ConvertTo-Json | Set-Content -Path $posPath -Encoding UTF8
    } catch {}
}

function Load-PanelGeom {
    if (Test-Path $panelGeomPath) {
        try { return (Get-Content $panelGeomPath -Raw | ConvertFrom-Json) } catch {}
    }
    if (Test-Path $settingsPath) {
        try {
            $s = Get-Content $settingsPath -Raw | ConvertFrom-Json
            return @{ x = $s.panelX; y = $s.panelY; w = $s.panelWidth; h = $s.panelHeight }
        } catch {}
    }
    return $null
}

function Save-PanelGeom([double]$X, [double]$Y, [double]$W, [double]$H) {
    try {
        New-Item -ItemType Directory -Force -Path $appDataDir | Out-Null
        @{ x = [math]::Round($X); y = [math]::Round($Y); w = [math]::Round($W); h = [math]::Round($H) } | ConvertTo-Json | Set-Content -Path $panelGeomPath -Encoding UTF8
    } catch {}
}

[void](Ensure-WebServer)

# ---- Build Floating HUD Window (SizeToContent = WidthAndHeight so vertical/horizontal & petSize scale seamlessly)
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="T3 DeskCat HUD"
        SizeToContent="WidthAndHeight"
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

$script:appClosing = $false
$script:locked = $false
$script:panelPinned = $false
$script:panelPosition = "pet"
$script:panelOpacity = 100
$script:isDark = $true
$script:baseHudOpacity = 1.0
$script:petIdleFade = $false
$script:hoveringHud = $false
$script:dragStart = $null
$script:dragOrigin = $null
$script:didDrag = $false
$script:lastPanelToggleUtc = [DateTime]::MinValue
$script:panelWin = $null
$script:webView = $null
$script:wv2InitStarted = $false
$script:registeredHotkey = $null
$script:hudHwnd = [IntPtr]::Zero
$script:trayIcon = $null
$script:HOTKEY_ID = 0x4443

$initGeom = Load-PanelGeom
$script:panelW = if ($initGeom -and $initGeom.w -ge 320 -and $initGeom.w -le 680) { [double]$initGeom.w } else { 390.0 }
$script:panelH = if ($initGeom -and $initGeom.h -ge 420 -and $initGeom.h -le 1080) { [double]$initGeom.h } else { 666.0 }

function Apply-HudOpacity {
    $op = $script:baseHudOpacity
    if ($script:petIdleFade -and -not $script:hoveringHud) {
        $op = [math]::Min($op, 0.35)
    }
    $window.Opacity = [math]::Max(0.2, [math]::Min(1.0, $op))
}

$window.Add_MouseEnter({ $script:hoveringHud = $true; Apply-HudOpacity })
$window.Add_MouseLeave({ $script:hoveringHud = $false; Apply-HudOpacity })

function Sync-GlobalHotkey([string]$Combo) {
    if ($isTestMode -or $script:hudHwnd -eq [IntPtr]::Zero) { return }
    $norm = if ($Combo) { $Combo.Trim() } else { "" }
    if ($norm -eq $script:registeredHotkey) { return }
    [void][DeskCatWin32]::UnregisterHotKey($script:hudHwnd, $script:HOTKEY_ID)
    $script:registeredHotkey = $norm
    if (-not $norm) {
        try { [void](Invoke-DeskCatApi "report_hotkey_status" @{ error = $null }) } catch {}
        return
    }
    $parsed = Parse-Hotkey $norm
    if (-not $parsed) {
        try { [void](Invoke-DeskCatApi "report_hotkey_status" @{ error = "不支援的快捷鍵格式：$norm" }) } catch {}
        return
    }
    $ok = [DeskCatWin32]::RegisterHotKey($script:hudHwnd, $script:HOTKEY_ID, $parsed.Mods, $parsed.Vk)
    $errMsg = if ($ok) { $null } else { "快捷鍵 $norm 已被其他程式佔用，請換一組" }
    try { [void](Invoke-DeskCatApi "report_hotkey_status" @{ error = $errMsg }) } catch {}
}

function Apply-PanelVisuals {
    if (-not $script:panelWin) { return }
    $pal = if ($script:isDark) { $palDark } else { $palLight }
    $script:panelWin.Background = $pal.PanelBg
    $script:panelWin.BorderBrush = $pal.PanelBd
    # Keep text legible while making panelOpacity slider meaningfully adjust translucency (0.78..1.0)
    $script:panelWin.Opacity = [math]::Max(0.78, [math]::Min(1.0, 0.78 + 0.22 * ($script:panelOpacity / 100.0)))
    if ($script:webView) { $script:webView.DefaultBackgroundColor = $pal.WvBg }
    $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:panelWin)).Handle
    if ($hwnd -ne [IntPtr]::Zero) { [DeskCatWin32]::ApplyWindowChrome($hwnd, $script:isDark) }
}

function Ensure-PopupPanel {
    if ($null -ne $script:panelWin) { return $true }
    if (-not $script:wv2Loaded) { return $false }

    $pw = New-Object System.Windows.Window
    $pw.Title = "T3 DeskCat Panel"
    $pw.Width = $script:panelW
    $pw.Height = $script:panelH
    $pw.MinWidth = 320
    $pw.MinHeight = 420
    $pw.MaxWidth = 680
    $pw.MaxHeight = 1080
    $pw.WindowStyle = [System.Windows.WindowStyle]::None
    $pw.ResizeMode = [System.Windows.ResizeMode]::NoResize
    $pw.Topmost = $true
    $pw.ShowInTaskbar = $false
    $pw.BorderThickness = New-Object System.Windows.Thickness(1)
    $pw.UseLayoutRounding = $true
    $pw.SnapsToDevicePixels = $true

    # Zero-chrome eliminates the 6px DWM top bar while keeping clean rounded corners
    $chrome = New-Object System.Windows.Shell.WindowChrome
    $chrome.CaptionHeight = 0
    $chrome.GlassFrameThickness = New-Object System.Windows.Thickness(0)
    $chrome.ResizeBorderThickness = New-Object System.Windows.Thickness(0)
    $chrome.CornerRadius = New-Object System.Windows.CornerRadius(12)
    [System.Windows.Shell.WindowChrome]::SetWindowChrome($pw, $chrome)

    $wv = New-Object Microsoft.Web.WebView2.Wpf.WebView2
    $pw.Content = $wv

    $pw.Add_SourceInitialized({
        param($s, $e)
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($s)).Handle
        [DeskCatWin32]::ApplyWindowChrome($hwnd, $script:isDark)
    })

    $pw.Add_LocationChanged({
        param($s, $e)
        if ($s.IsVisible -and $s.Left -gt -10000) {
            Save-PanelGeom $s.Left $s.Top $s.Width $s.Height
        }
    })

    $pw.Add_SizeChanged({
        param($s, $e)
        if ($s.IsVisible -and $s.Width -ge 320 -and $s.Height -ge 420) {
            $script:panelW = $s.Width
            $script:panelH = $s.Height
            Save-PanelGeom $s.Left $s.Top $s.Width $s.Height
        }
    })

    $pw.Add_KeyDown({
        param($s, $e)
        if ($e.Key -eq [System.Windows.Input.Key]::Escape) { $s.Hide() }
    })

    $pw.Add_Deactivated({
        param($s, $e)
        if ($script:panelPinned) { return }
        $elapsedMs = ([DateTime]::UtcNow - $script:lastPanelToggleUtc).TotalMilliseconds
        if ($elapsedMs -lt 320) { return }
        if ($s.IsVisible) { $s.Hide() }
    })

    $pw.Add_Closing({
        param($s, $e)
        if (-not $script:appClosing) {
            $e.Cancel = $true
            $s.Hide()
        }
    })

    $script:panelWin = $pw
    $script:webView = $wv
    Apply-PanelVisuals
    return $true
}

function Handle-HostWebMessage([string]$RawJson) {
    try { $msg = $RawJson | ConvertFrom-Json } catch { return }
    if (-not $msg -or -not $msg.type) { return }
    switch ([string]$msg.type) {
        "hide_panel" {
            if ($script:panelWin -and $script:panelWin.IsVisible) { $script:panelWin.Hide() }
        }
        "set_panel_pinned" {
            $script:panelPinned = [bool]$msg.pinned
            if ($script:miPin) { $script:miPin.IsChecked = $script:panelPinned }
        }
        "settings_updated" {
            Refresh-Once
        }
        "start_drag" {
            if ($script:panelWin) {
                $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:panelWin)).Handle
                [DeskCatWin32]::StartDrag($hwnd)
            }
        }
        "start_resize" {
            if ($script:panelWin) {
                $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:panelWin)).Handle
                [DeskCatWin32]::StartResize($hwnd, [string]$msg.dir)
            }
        }
    }
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
                $err = if ($script:wv2EnvTask.Exception) { $script:wv2EnvTask.Exception.InnerException.Message } else { "env creation failed" }
                if ($script:wv2OnReady) { & $script:wv2OnReady $false $err }
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
                $err = if ($script:wv2InitTask.Exception) { $script:wv2InitTask.Exception.InnerException.Message } else { "EnsureCoreWebView2Async failed" }
                if ($script:wv2OnReady) { & $script:wv2OnReady $false $err }
                return
            }
            try {
                $script:webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = $false
                $script:webView.CoreWebView2.Settings.AreStatusBarEnabled = $false
                $script:webView.CoreWebView2.Settings.AreDevToolsEnabled = $false
                $script:webView.CoreWebView2.Settings.IsWebMessageEnabled = $true
                $script:webView.CoreWebView2.Add_WebMessageReceived({
                    param($sender, $ev)
                    try {
                        $raw = $ev.TryGetWebMessageAsString()
                        if ($raw) { Handle-HostWebMessage $raw }
                    } catch {}
                })
            } catch {}
            $script:wv2Stage = "ready"
            if ($script:wv2OnReady) { & $script:wv2OnReady $true $null }
            $script:webView.Source = [Uri]$panelUrl
        }
    })
    $script:wv2PollTimer.Start()
}

function Position-Panel {
    if (-not $script:panelWin) { return }
    $wa = [System.Windows.SystemParameters]::WorkArea
    $gap = 8.0
    $pw = $script:panelWin.Width
    $ph = $script:panelWin.Height
    $mode = if ($script:panelPosition) { $script:panelPosition } else { "pet" }

    $x = $wa.Right - $pw - 12
    $y = $wa.Top + 12

    if ($mode -eq "remember") {
        $g = Load-PanelGeom
        if ($g -and $null -ne $g.x -and $null -ne $g.y) {
            $x = [math]::Max($wa.Left + 8, [math]::Min([double]$g.x, $wa.Right - $pw - 8))
            $y = [math]::Max($wa.Top + 8, [math]::Min([double]$g.y, $wa.Bottom - $ph - 8))
        }
    } elseif ($mode -eq "top_right") {
        $x = $wa.Right - $pw - 12; $y = $wa.Top + 12
    } elseif ($mode -eq "bottom_right") {
        $x = $wa.Right - $pw - 12; $y = $wa.Bottom - $ph - 12
    } elseif ($mode -eq "top_left") {
        $x = $wa.Left + 12; $y = $wa.Top + 12
    } elseif ($mode -eq "bottom_left") {
        $x = $wa.Left + 12; $y = $wa.Bottom - $ph - 12
    } elseif ($mode -eq "center") {
        $x = $wa.Left + ($wa.Width - $pw) / 2; $y = $wa.Top + ($wa.Height - $ph) / 2
    } else {
        # "pet" (default): adjacent to HUD, never overlapping when space allows
        $hudLeft = $window.Left
        $hudTop = $window.Top
        $hudW = if ($window.ActualWidth -gt 0) { $window.ActualWidth } else { 192.0 }
        $hudH = if ($window.ActualHeight -gt 0) { $window.ActualHeight } else { 112.0 }
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
            $spaceLeft = ($hudLeft - $gap) - $wa.Left
            $spaceRight = $wa.Right - ($hudLeft + $hudW + $gap)
            if ($spaceLeft -ge $pw) { $x = $hudLeft - $gap - $pw }
            elseif ($spaceRight -ge $pw) { $x = $hudLeft + $hudW + $gap }
            $y = [math]::Max($wa.Top + 8, [math]::Min($hudTop, $wa.Bottom - $ph - 8))
        }
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
    Position-Panel
    $script:panelWin.Show()
    [void]$script:panelWin.Activate()
    Start-WebView2Init $null
}

# ---- Self-test mode
if ($SelfTestPanel) {
    if (-not $script:wv2Loaded) {
        Write-Error "Signed Microsoft.Web.WebView2.Wpf.dll not found."
        exit 1
    }
    [void](Ensure-PopupPanel)
    $script:panelWin.Left = -32000
    $script:panelWin.Top = -32000
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
    $timeoutTimer.Add_Tick({ $timeoutTimer.Stop(); $script:appClosing = $true; $script:panelWin.Close() })
    $timeoutTimer.Start()
    [void]$script:panelWin.ShowDialog()
    Write-Host "SELFTEST_PANEL: $script:testResult"
    if (-not $script:testDone -or -not $script:testResult.StartsWith("NAV_OK=True")) { exit 1 }
    exit 0
}

# ---- HUD Context Menu
$ctx = New-Object System.Windows.Controls.ContextMenu

$miToggle = New-Object System.Windows.Controls.MenuItem
$miToggle.Header = "開啟 / 收合面板"
$miToggle.Add_Click({ Toggle-AdjacentPanel })
[void]$ctx.Items.Add($miToggle)

$script:miPin = New-Object System.Windows.Controls.MenuItem
$script:miPin.Header = "釘選面板（點外面不收合）"
$script:miPin.IsCheckable = $true
$script:miPin.Add_Click({
    $script:panelPinned = $script:miPin.IsChecked
    try { [void](Invoke-DeskCatApi "set_panel_pinned" @{ pinned = $script:panelPinned }) } catch {}
})
[void]$ctx.Items.Add($script:miPin)

$miBrowser = New-Object System.Windows.Controls.MenuItem
$miBrowser.Header = "在瀏覽器開啟完整網頁"
$miBrowser.Add_Click({ Open-InBrowser })
[void]$ctx.Items.Add($miBrowser)

[void]$ctx.Items.Add((New-Object System.Windows.Controls.Separator))

$miRefresh = New-Object System.Windows.Controls.MenuItem
$miRefresh.Header = "立即重新整理"
$miRefresh.Add_Click({
    try { [void](Invoke-DeskCatApi "refresh_now") } catch {}
    Refresh-Once
})
[void]$ctx.Items.Add($miRefresh)

$miLock = New-Object System.Windows.Controls.MenuItem
$miLock.Header = "鎖定浮動位置"
$miLock.IsCheckable = $true
$miLock.Add_Click({ $script:locked = $miLock.IsChecked })
[void]$ctx.Items.Add($miLock)

[void]$ctx.Items.Add((New-Object System.Windows.Controls.Separator))

$miQuit = New-Object System.Windows.Controls.MenuItem
$miQuit.Header = "結束 T3 DeskCat"
$miQuit.Add_Click({
    $script:appClosing = $true
    if ($script:panelWin) { try { $script:panelWin.Close() } catch {} }
    $window.Close()
})
[void]$ctx.Items.Add($miQuit)

$card.ContextMenu = $ctx

# ---- System Tray Icon (so showPet=false still gives instant access to panel & settings)
if (-not $isTestMode) {
    $ni = New-Object System.Windows.Forms.NotifyIcon
    if (Test-Path $iconPath) {
        $ni.Icon = New-Object System.Drawing.Icon($iconPath)
    } else {
        $ni.Icon = [System.Drawing.SystemIcons]::Application
    }
    $ni.Text = "T3 DeskCat"
    $trayMenu = New-Object System.Windows.Forms.ContextMenuStrip

    $tmOpen = $trayMenu.Items.Add("開啟 / 收合面板")
    $tmOpen.Add_Click({ $window.Dispatcher.BeginInvoke([System.Action]{ Toggle-AdjacentPanel }) | Out-Null })

    $tmHud = $trayMenu.Items.Add("顯示 / 隱藏浮動卡片")
    $tmHud.Add_Click({
        $window.Dispatcher.BeginInvoke([System.Action]{
            $nextShow = -not $window.IsVisible
            if ($nextShow) { $window.Show() } else { $window.Hide() }
            try { [void](Invoke-DeskCatApi "update_settings" @{ newSettings = @{ showPet = $nextShow } }) } catch {}
        }) | Out-Null
    })

    $tmRef = $trayMenu.Items.Add("立即重新整理")
    $tmRef.Add_Click({
        $window.Dispatcher.BeginInvoke([System.Action]{
            try { [void](Invoke-DeskCatApi "refresh_now") } catch {}
            Refresh-Once
        }) | Out-Null
    })

    [void]$trayMenu.Items.Add("-")

    $tmExit = $trayMenu.Items.Add("結束 T3 DeskCat")
    $tmExit.Add_Click({
        $window.Dispatcher.BeginInvoke([System.Action]{
            $script:appClosing = $true
            if ($script:panelWin) { try { $script:panelWin.Close() } catch {} }
            $window.Close()
        }) | Out-Null
    })

    $ni.ContextMenuStrip = $trayMenu
    $ni.Add_MouseClick({
        param($s, $ev)
        if ($ev.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $window.Dispatcher.BeginInvoke([System.Action]{ Toggle-AdjacentPanel }) | Out-Null
        }
    })
    $ni.Visible = $true
    $script:trayIcon = $ni
}

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
        if ([math]::Abs($dx) -ge 4 -or [math]::Abs($dy) -ge 4) { $script:didDrag = $true }
        if ($script:didDrag) {
            $window.Left = $script:dragOrigin.X + $dx
            $window.Top = $script:dragOrigin.Y + $dy
            if ($script:panelWin -and $script:panelWin.IsVisible -and $script:panelPosition -eq "pet") {
                Position-Panel
            }
        }
    }
})

$card.Add_MouseLeftButtonUp({
    param($s, $e)
    if ($card.IsMouseCaptured) { $card.ReleaseMouseCapture() }
    if ($script:didDrag) {
        Save-HudPosition $window.Left $window.Top
    } else {
        Toggle-AdjacentPanel
    }
    $script:dragStart = $null
    $script:didDrag = $false
})

function New-HudCell([string]$Provider, [string]$Name, [int]$DispPct, [int]$RemPct, [string]$SubText, [int]$WorkTh, [int]$SleepTh, [double]$Scale, [bool]$Horizontal, [bool]$IsFirst, [bool]$IsDark) {
    $pal = if ($IsDark) { $palDark } else { $palLight }
    $baseCellW = if ($Horizontal) { 126 } else { 164 }
    $cellW = [math]::Round($baseCellW * $Scale)
    $fontMain = [math]::Round(11.5 * $Scale, 1)
    $fontSub = [math]::Round(9.5 * $Scale, 1)

    $container = New-Object System.Windows.Controls.StackPanel
    $container.Orientation = "Vertical"
    $container.Width = $cellW
    if (-not $IsFirst) {
        if ($Horizontal) {
            $container.Margin = New-Object System.Windows.Thickness([math]::Round(10 * $Scale), 0, 0, 0)
        } else {
            $container.Margin = New-Object System.Windows.Thickness(0, [math]::Round(7 * $Scale), 0, 0)
        }
    }

    $top = New-Object System.Windows.Controls.DockPanel
    $top.LastChildFill = $true

    $pctText = New-Object System.Windows.Controls.TextBlock
    $pctText.Text = "$DispPct%"
    $pctText.FontFamily = New-Object System.Windows.Media.FontFamily("Segoe UI Semibold")
    $pctText.FontSize = $fontMain
    $pctText.Foreground = Get-ToneBrush $RemPct $WorkTh $SleepTh $IsDark
    $pctText.VerticalAlignment = "Center"
    [System.Windows.Controls.DockPanel]::SetDock($pctText, "Right")
    [void]$top.Children.Add($pctText)

    $leftStack = New-Object System.Windows.Controls.StackPanel
    $leftStack.Orientation = "Horizontal"
    $leftStack.VerticalAlignment = "Center"

    $dotSize = [math]::Max(6, [math]::Round(7 * $Scale))
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = $dotSize
    $dot.Height = $dotSize
    $dot.Fill = Get-ProviderBrush $Provider
    $dot.Margin = New-Object System.Windows.Thickness(0, 0, 5, 0)
    $dot.VerticalAlignment = "Center"
    [void]$leftStack.Children.Add($dot)

    $nameText = New-Object System.Windows.Controls.TextBlock
    $nameText.Text = $Name
    $nameText.FontFamily = New-Object System.Windows.Media.FontFamily("Segoe UI Semibold")
    $nameText.FontSize = $fontMain
    $nameText.Foreground = $pal.Text
    $nameText.TextTrimming = "CharacterEllipsis"
    $nameText.MaxWidth = [math]::Max(52, $cellW - [math]::Round(48 * $Scale))
    $nameText.VerticalAlignment = "Center"
    [void]$leftStack.Children.Add($nameText)

    [void]$top.Children.Add($leftStack)
    [void]$container.Children.Add($top)

    $barH = [math]::Max(3, [math]::Round(4 * $Scale))
    $barBg = New-Object System.Windows.Controls.Border
    $barBg.Height = $barH
    $barBg.CornerRadius = New-Object System.Windows.CornerRadius($barH / 2.0)
    $barBg.Background = $pal.Track
    $barBg.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)

    $clamped = [math]::Max(0, [math]::Min(100, $DispPct))
    $barFill = New-Object System.Windows.Controls.Border
    $barFill.Height = $barH
    $barFill.CornerRadius = New-Object System.Windows.CornerRadius($barH / 2.0)
    $barFill.Background = Get-ToneBrush $RemPct $WorkTh $SleepTh $IsDark
    $barFill.HorizontalAlignment = "Left"
    $barFill.Width = [math]::Round($cellW * ($clamped / 100.0))
    $barBg.Child = $barFill
    [void]$container.Children.Add($barBg)

    if ($SubText) {
        $sub = New-Object System.Windows.Controls.TextBlock
        $sub.Text = $SubText
        $sub.FontFamily = New-Object System.Windows.Media.FontFamily("Segoe UI")
        $sub.FontSize = $fontSub
        $sub.Foreground = $pal.Muted
        $sub.Margin = New-Object System.Windows.Thickness(0, 2, 0, 0)
        $sub.TextTrimming = "CharacterEllipsis"
        [void]$container.Children.Add($sub)
    }

    return $container
}

function Update-HudView($data) {
    $rowsPanel.Children.Clear()
    if (-not $data) {
        $rowsPanel.Orientation = "Vertical"
        $card.Background = $palDark.Bg
        $card.BorderBrush = $palDark.Border
        $card.BorderThickness = New-Object System.Windows.Thickness(1)
        $card.Padding = New-Object System.Windows.Thickness(10, 8, 10, 9)
        $msg = New-Object System.Windows.Controls.TextBlock
        $msg.Text = "T3 DeskCat 連線中..."
        $msg.FontSize = 11.5
        $msg.Foreground = $palDark.Muted
        [void]$rowsPanel.Children.Add($msg)
        return
    }

    $s = $data.settings
    $isDark = Resolve-IsDark $s
    $darkChanged = ($isDark -ne $script:isDark)
    $script:isDark = $isDark
    $pal = if ($isDark) { $palDark } else { $palLight }

    $script:panelPinned = [bool]$s.panelPinned
    if ($script:miPin) { $script:miPin.IsChecked = $script:panelPinned }
    $script:panelPosition = if ($s.panelPosition) { [string]$s.panelPosition } else { "pet" }
    $script:panelOpacity = if ($null -ne $s.panelOpacity) { [int]$s.panelOpacity } else { 100 }
    $script:baseHudOpacity = if ($s.petOpacity -ge 30 -and $s.petOpacity -le 100) { [double]$s.petOpacity / 100.0 } else { 1.0 }
    $script:petIdleFade = [bool]$s.petIdleFade
    Apply-HudOpacity
    if ($darkChanged -or $script:panelWin) { Apply-PanelVisuals }

    # Sync global hotkey and showPet visibility
    Sync-GlobalHotkey ([string]$s.hotkey)
    if (-not $isTestMode) {
        $wantPet = ($s.showPet -ne $false)
        if ($wantPet -and -not $window.IsVisible) { $window.Show() }
        elseif (-not $wantPet -and $window.IsVisible) { $window.Hide() }
    }

    $petSize = if ($s.petSize -ge 48 -and $s.petSize -le 128) { [double]$s.petSize } else { 64.0 }
    $petTheme = if ($s.petTheme) { [string]$s.petTheme } else { "hud_gauge" }

    # Custom image theme
    if ($petTheme -eq "custom") {
        $mood = [string]$data.mood
        $imgUrl = if ($mood -eq "sleeping" -and $s.customImageSleeping) { $s.customImageSleeping }
                  elseif ($mood -eq "sweating" -and $s.customImageSweating) { $s.customImageSweating }
                  else { $s.customImageWorking }
        $bmp = Convert-DataUrlToImage $imgUrl
        if ($bmp) {
            $card.Background = [System.Windows.Media.Brushes]::Transparent
            $card.BorderThickness = New-Object System.Windows.Thickness(0)
            $card.Padding = New-Object System.Windows.Thickness(0)
            $img = New-Object System.Windows.Controls.Image
            $img.Source = $bmp
            $img.Width = $petSize
            $img.Height = $petSize
            $img.Stretch = [System.Windows.Media.Stretch]::Uniform
            [void]$rowsPanel.Children.Add($img)
            return
        }
    }

    # Standard HUD gauge card
    $scale = [math]::Max(0.88, [math]::Min(1.22, 0.85 + ($petSize - 48.0) / 80.0 * 0.35))
    $horizontal = ($s.hudLayout -eq "horizontal") -and ($data.items.Count -ge 2)
    $rowsPanel.Orientation = if ($horizontal) { "Horizontal" } else { "Vertical" }
    $card.Background = $pal.Bg
    $card.BorderBrush = $pal.Border
    $card.BorderThickness = New-Object System.Windows.Thickness(1)
    $card.Padding = New-Object System.Windows.Thickness([math]::Round(10 * $scale), [math]::Round(8 * $scale), [math]::Round(10 * $scale), [math]::Round(9 * $scale))

    $workTh = if ($s.workingThreshold) { [int]$s.workingThreshold } else { 70 }
    $sleepTh = if ($s.sleepingThreshold) { [int]$s.sleepingThreshold } else { 20 }
    $showUsed = ($s.usageDisplay -eq "used")

    $items = @($data.items)
    if ($items.Count -eq 0) {
        $msg = New-Object System.Windows.Controls.TextBlock
        $msg.Text = "尚無可用額度資料"
        $msg.FontSize = 11.5
        $msg.Foreground = $pal.Muted
        [void]$rowsPanel.Children.Add($msg)
        return
    }

    for ($i = 0; $i -lt $items.Count; $i++) {
        $it = $items[$i]
        $rem = [math]::Max(0, [math]::Min(100, [int]$it.effectiveRemaining))
        $dispPct = if ($showUsed) { 100 - $rem } else { $rem }
        $parts = @()
        foreach ($w in @($it.windows)) {
            $lbl = if ($w.label -eq "Wk") { "週" } else { $w.label }
            $wVal = if ($showUsed) { 100 - [int]$w.remainingPercent } else { [int]$w.remainingPercent }
            $parts += "$lbl $wVal%"
        }
        $sub = $parts -join " · "
        $cell = New-HudCell $it.provider $it.name $dispPct $rem $sub $workTh $sleepTh $scale $horizontal ($i -eq 0) $isDark
        # Color reflects remaining health even when showing used %
        [void]$rowsPanel.Children.Add($cell)
    }

    if ($script:trayIcon) {
        $script:trayIcon.Text = "T3 DeskCat · 剩餘 $($data.overallScore)%"
    }
    $card.ToolTip = "T3 DeskCat（左鍵彈出面板 · 拖曳移動 · 右鍵選單）"
}

$script:lastServerRestart = [DateTime]::MinValue

function Refresh-Once {
    try {
        $data = Invoke-DeskCatApi "get_hud_data"
        Update-HudView $data
    } catch {
        if (-not (Test-PortOpen)) {
            $now = [DateTime]::UtcNow
            if (($now - $script:lastServerRestart).TotalSeconds -ge 30) {
                $script:lastServerRestart = $now
                if (Ensure-WebServer) {
                    try {
                        $data = Invoke-DeskCatApi "get_hud_data"
                        Update-HudView $data
                        return
                    } catch {}
                }
            }
        }
        Update-HudView $null
    }
}

# Register WM_HOTKEY hook once the HUD HWND exists
$window.Add_SourceInitialized({
    param($s, $e)
    $script:hudHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($s)).Handle
    $src = [System.Windows.Interop.HwndSource]::FromHwnd($script:hudHwnd)
    if ($src) {
        $src.AddHook([System.Windows.Interop.HwndSourceHook]{
            param([IntPtr]$hwnd, [int]$msg, [IntPtr]$wParam, [IntPtr]$lParam, [ref]$handled)
            if ($msg -eq [DeskCatWin32]::WM_HOTKEY -and $wParam.ToInt32() -eq $script:HOTKEY_ID) {
                $handled.Value = $true
                Toggle-AdjacentPanel
            }
            return [IntPtr]::Zero
        })
    }
    if ($script:pendingHotkey) {
        Sync-GlobalHotkey $script:pendingHotkey
    }
})

# Initial paint
try {
    $initData = Invoke-DeskCatApi "get_hud_data"
    if ($initData -and $initData.settings) { $script:pendingHotkey = [string]$initData.settings.hotkey }
    Update-HudView $initData
} catch {
    Update-HudView $null
}

# Preview render mode
if ($RenderPreviewPng) {
    $card.Measure((New-Object System.Windows.Size([double]::PositiveInfinity, [double]::PositiveInfinity)))
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

# Timers
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(15)
$timer.Add_Tick({ Refresh-Once })
$timer.Start()

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
    if ($script:hudHwnd -ne [IntPtr]::Zero) {
        [void][DeskCatWin32]::UnregisterHotKey($script:hudHwnd, $script:HOTKEY_ID)
    }
    if ($script:panelWin) { try { $script:panelWin.Close() } catch {} }
    if ($script:trayIcon) {
        try { $script:trayIcon.Visible = $false; $script:trayIcon.Dispose() } catch {}
    }
    if ($toggleEvent) { try { $toggleEvent.Dispose() } catch {} }
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
})

[void]$window.ShowDialog()
