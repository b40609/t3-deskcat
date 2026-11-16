<div align="center">

# 🐾 T3 DeskCat · Salary Cat

**A lightweight, always-on-top Salary-Cat desktop pet & multi-account AI quota monitor built with Rust + Tauri v2.**  
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

**T3 DeskCat** lives right at the edge of your screen as a dedicated "Salary-Cat" desktop companion:
- **Zero Configuration**: Automatically discovers your local credentials from T3 Code out of the box.
- **Mood Reflects Quotas**: The cat's typing intensity directly represents your quota reserve. Energetic when full, frantically sweating when running low, and asleep when drained.
- **Smart Recommendations**: Hover over the cat anytime to see which account currently offers the highest quota.
- **Ultra Lightweight**: Powered by Rust & Tauri v2 with less than ~50 MB RAM and virtually 0% idle CPU overhead.

---

## ✨ Key Features

### 1. 🐱 3-Stage Pixel Typing Animations
Transparent, frameless, and resizable (`48px – 128px`, defaults to `64px`), freely draggable across multiple monitors:

| State | Visual Behavior | Default Threshold |
| :--- | :--- | :--- |
| **Working** | Crisp typing in front of a cyan glowing monitor, energized | Overall Score `> 70%` |
| **Sweating** | Rapid frenzy typing, sweating with a steaming coffee cup | Overall Score `20% ~ 70%` |
| **Sleeping** | Monitor dimmed, slumped over the keyboard snoring (`Zzz`) | Overall Score `< 20%` or `0%` |

### 2. 🔍 Zero-Setup Auto-Discovery
Parses active T3 Code profile configurations and local auth tokens without any manual API Key entry or redundant OAuth authorizations:
- **Claude Code**: Read-only extraction of dynamic 5-hour rolling windows and 7-day weekly limits.
- **Antigravity (Google / Gemini)**: Refreshes short-lived tokens in-memory without ever altering local token files on disk. Tracks primary Gemini 5h / Weekly pools with optional secondary pool visibility.
- **ChatGPT / Codex**: Read-only status parsing of primary and secondary reset windows.

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
