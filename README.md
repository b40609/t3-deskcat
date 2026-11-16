# T3 DeskCat

> A lightweight, always-on-top **Salary-Cat (月薪貓)** desktop pet & multi-account quota monitor built with **Rust + Tauri v2** for **T3 Code** users.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB)
![Rust](https://img.shields.io/badge/Rust-Edition%202021-orange)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Zero-Setup T3 Code Auto-Discovery**  
  Automatically reads your configured provider instances from `~/.t3/userdata/settings.json` (plus `~/.claude*`, `~/.codex`, and `~/.gemini` fallbacks) without manual OAuth re-binding or storing duplicate tokens.
  - **Claude Code** (multi-profile `homePath` support: 5h & Weekly windows)
  - **Antigravity** (multi-instance support via `acp_token.json`: prioritizes the primary Gemini 5h & Weekly pools, with an optional toggle for Argon / 3P pools)
  - **Codex / ChatGPT** (`auth.json`: 5h / Weekly / Monthly windows)
- **Side-View Pixel Salary Cat (`64×64` default, `48px–128px` adjustable)**
  - **Working (`> 70%`)**: Typing briskly at the desk with a glowing cyan monitor.
  - **Sweating (`20% – 70%`)**: Frantic typing with a coffee mug and sweat drop.
  - **Sleeping (`< 20%` or `0%`)**: Slumped on the keyboard (`Zzz`) waiting for reset.
  - Hover over the cat anytime for a concise status tooltip (`Claude: <account> <pct>%｜AG: <account> <pct>%`).
- **Click-to-Expand Minimal Dashboard**
  - **Smart Picks**: Highlights the best available Claude and Antigravity accounts at a glance.
  - **Clean Progress Bars & Reset Countdowns**: Only essential numbers, auto-collapses when unfocused (with an optional Pin toggle).
- **Windows Native Notifications & Customizable Scoring**
  - Alerts on low quota, exhaustion (`0%`), and reset recovery (`100%`).
  - Switch between **Max-per-Provider Average** (`各家最高平均`, default) and **All-Accounts Average** (`全部帳號平均`), plus live sliders for mood thresholds and cat size.

## Privacy & Security

- **Strictly Read-Only for Claude & Codex**: Never modifies `.credentials.json` or `auth.json`.
- **In-Memory Google OAuth Refresh for Antigravity**: Refreshes short-lived access tokens strictly in memory without touching T3's `acp_token.json`.
- **No Telemetry**: All requests go directly from your machine to the official provider endpoints.

## Development

### Prerequisites
- Windows 10 / 11 with WebView2
- [Rust](https://rustup.rs/) + Visual Studio C++ Build Tools (MSVC + Windows SDK)
- Node.js 18+

### Run in Dev Mode
```bash
npm install
npm run tauri dev
```

### Build Installer / Binary
```bash
npm run tauri build
```

## License

[MIT](./LICENSE)
