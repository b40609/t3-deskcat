<div align="center">

# 🐾 T3 DeskCat

**A lightweight, always-on-top desktop pet & multi-account AI quota monitor built with Rust + Tauri v2.**  
*Designed for power users of T3 Code to effortlessly track multiple accounts across Claude, Antigravity, and ChatGPT.*

[![GitHub release](https://img.shields.io/github/v/release/b40609/t3-deskcat?color=24C8DB&logo=github)](https://github.com/b40609/t3-deskcat/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078D6?logo=windows)](https://github.com/b40609/t3-deskcat/releases)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2.12-FFC131?logo=tauri)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-Edition%202021-DEA584?logo=rust)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[繁體中文](README.md) • [English](README_en.md) • [日本語](README_ja.md) • [简体中文](README_zh-CN.md)

---

</div>

## 💡 Why T3 DeskCat?

Power users and software engineers working with **T3 Code** frequently maintain multiple subscriptions across various providers (e.g., **Claude × 3, Antigravity × 3, ChatGPT / Codex × 1**).  
Checking rate limits manually via command-line arguments or browser dashboards breaks developer flow and leads to unexpected mid-coding disruptions.

**T3 DeskCat** lives right at the edge of your screen as an animated desktop companion:
- **Zero Configuration**: Automatically discovers your local credentials from T3 Code out of the box.
- **Mood Reflects Quotas**: The cat's typing intensity directly represents your quota reserve. Energetic when full, frantically sweating when running low, and asleep when drained.
- **Smart Recommendations**: Hover over the cat anytime to see which account currently offers the highest quota.
- **Ultra Lightweight**: Powered by Rust & Tauri v2 with less than ~50 MB RAM and virtually 0% idle CPU overhead.

---

## ✨ Key Features

### 1. 🎨 Multiple Themes & Custom Virtual Pets (Themes & Custom Avatar)
Transparent, frameless, and resizable (`48px – 128px`, defaults to `64px`), freely draggable across multiple monitors:

- **🧭 Professional HUD Radial Gauge (Default & Productivity-focused)**:  
  Tailored for software engineers and deep-work sessions. A translucent cybernetic disc that renders real-time quota percentage (e.g. `88%`), a neon status progress arc (Cyan `>70%` / Amber `20~70%` / Crimson `<20%`), and a rotating scanner pulse. Sleek, distraction-free, and perfect for screen sharing.
- **🐱 DeskCat Classic Pixel Cat**:  
  The beloved 32×32 side-view cat typing at a desk, featuring 3 reactive animation states (Working `>70%`, Sweating `20%~70%`, and Sleeping `<20%`).
- **🖼️ Custom Virtual Pets (User Uploads)**:  
  Replace the avatar with any pet, anime character, or mascot of your choice (PNG, JPG, or animated GIF). Upload distinct images for each state, or provide a single favorite image that automatically reacts with tremor shakes and floating `Zzz` bubbles!

### 2. 🔍 Zero-Setup Auto-Discovery
**T3 Code is not required.** DeskCat reuses the sign-ins of each official CLI — no API keys, no extra OAuth logins:
- **Claude Code**: scans `~/.claude`, `CLAUDE_CONFIG_DIR` and multi-account profile folders such as `~/.claude-<name>`; reads `.credentials.json` read-only for the 5-hour and weekly limits.
- **ChatGPT / Codex**: scans `CODEX_HOME`, `~/.codex` and `~/.codex-<name>`; reads `auth.json` read-only.
- **Antigravity (Google / Gemini)**: runs the official `agy -p /usage --output-format json` and never touches the sign-in (agy keeps it in the OS credential store). Only runs when agy is signed in.
- **T3 Code (optional)**: when installed, its multi-account instances and display names are picked up as well.
- **Other folders**: add paths to `extraAccountDirs` in `%APPDATA%\t3-deskcat\settings.json`.
- Which accounts were found, and from where, is written to `%APPDATA%\t3-deskcat\deskcat.log`.

### 3. 🎯 Smart Picks & Minimal Hover Tooltip
- **Hover Tooltip**: Instant summary of best-suited accounts and remaining percentage:
  ```text
  Claude: Account-2 94% ｜ AG: Account-1 88%
  ```
- **Click-to-Expand Panel**: Click either the cat or the system tray icon to reveal an elegant dark glassmorphism dashboard. Includes countdown timers, visual progress bars, and an optional 📌 Pin toggle.

### 4. ⚙️ Flexible Metrics & Native Alerts
- **Scoring Modes**:
  - `Max per Provider Average` (Default, represents immediate switching capacity)
  - `All Accounts Average` (Represents overall inventory health)
- **Windows Native Notifications**: Toast notifications triggered on low quota warnings, complete exhaustion (`0%`), and quota resets.
- **Autostart Support**: Toggle Windows startup behavior directly from settings.

---

## ❓ FAQ

- **An account is missing?** Open `%APPDATA%\t3-deskcat\deskcat.log`; it lists every detected account and where it came from. Add folders outside the default locations to `extraAccountDirs` in `settings.json`.
- **Only one Antigravity account?** Without T3 Code, Antigravity is read through the official `agy` CLI, which is signed in to one account at a time. T3 Code's multi-account instances show several.
- **"Credentials expired"?** DeskCat never refreshes or rewrites sign-ins. Use that account once in Claude Code / Codex / Antigravity and it updates itself.
- **SmartScreen warning on install?** The installer is not code-signed yet. Click "More info" → "Run anyway", or build from source below.
- **Phone page?** Off by default. It needs this PC and your phone on the same Tailscale network; turn it on in Settings.
## 🔒 Security & Privacy First

- **No Telemetry**: No third-party analytics, metrics collection, or tracking scripts.
- **Strictly Read-Only**: Local token stores for Claude and Codex are accessed in read-only mode.
- **In-Memory Refresh**: Antigravity token refreshing is executed strictly within runtime memory; no changes are committed to disk.
- **100% Open Source**: Full Rust and TypeScript source code available for public review.

---

## 🚀 Download & Installation

### Pre-built Windows Installer
Download the latest installer from [GitHub Releases](https://github.com/b40609/t3-deskcat/releases/latest):
- **`T3 DeskCat_x.x.x_x64-setup.exe`**: Automatic installer with desktop shortcut and start menu integration.

### Quick Usage Guide
1. **Initial Position**: Upon launch, DeskCat appears near the bottom-right corner of your primary monitor.
2. **Dragging**: Click and hold the left mouse button to drag the cat anywhere on your screens. The position is saved automatically.
3. **Toggle Dashboard**: Single-click the cat or left-click the system tray icon.
4. **Settings**: Adjust pet size, custom thresholds, and calculation modes inside the Settings tab.

---

## 🛠️ Building from Source

### Prerequisites
- **Windows 10 / 11** with Microsoft Edge WebView2 (pre-installed on modern Windows)
- **Node.js** 18+ and **npm**
- **Rust** 1.77+ and Cargo
- **Visual Studio C++ Build Tools** (MSVC compiler & Windows SDK)

### Step-by-Step Build
```bash
# 1. Clone repository
git clone https://github.com/b40609/t3-deskcat.git
cd t3-deskcat

# 2. Install dependencies
npm install

# 3. Run development mode
npm run tauri dev

# 4. Run tests
cd src-tauri && cargo test && cd ..

# 5. Build production bundle
npm run tauri build
```
The final installer binary will be located at:  
`src-tauri/target/release/bundle/nsis/T3 DeskCat_<version>_x64-setup.exe`

---

## 📄 License

Distributed under the [MIT License](LICENSE).
