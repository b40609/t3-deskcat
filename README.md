<div align="center">

# 🐾 T3 DeskCat

**A lightweight, always-on-top desktop pet & multi-account AI quota monitor built with Rust + Tauri v2.**  
*為 T3 Code 開發者打造的桌面寵物與多模型多帳號額度雷達（零手動綁定、無感常駐、三段像素動態）*

[![GitHub release](https://img.shields.io/github/v/release/b40609/t3-deskcat?color=24C8DB&logo=github)](https://github.com/b40609/t3-deskcat/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078D6?logo=windows)](https://github.com/b40609/t3-deskcat/releases)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2.12-FFC131?logo=tauri)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-Edition%202021-DEA584?logo=rust)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[繁體中文](README.md) • [English](README_en.md) • [日本語](README_ja.md) • [简体中文](README_zh-CN.md)

---

</div>

## 💡 為什麼需要 T3 DeskCat？

身為高強度使用 **T3 Code** 的重度使用者，通常會同時訂閱多個 AI 服務的多組帳號（例如 **Claude × 3、Antigravity × 3、ChatGPT / Codex × 1**）。  
過去每次切換或寫程式途中，額度用盡才發現卡住；或者需要繁瑣地打開網頁或 CLI 一個個查詢剩餘用量。

**T3 DeskCat** 直接化身為一隻常駐在桌面邊緣的側面打字小貓：
- **零手動設定**：自動掃描 T3 Code 本機憑證，啟動即用。
- **神態反映額度**：小貓打字精力充沛代表額度充足；冒汗狂敲代表額度吃緊；趴在鍵盤睡覺代表額度見底。
- **最佳帳號智慧推薦**：滑鼠懸停即可知道目前各家最該使用哪一個帳號。
- **超低系統開銷**：基於 Rust + Tauri v2 原生架構，記憶體佔用僅約 50 MB，閒置 CPU 趨近於 0%。

---

## ✨ 核心特性

### 1. 🎨 多樣化外觀風格與自由自訂虛擬寵物（Themes & Custom Avatar）
透明無邊框設計、支援自定義尺寸（48px ~ 128px，預設 64px）與滑鼠隨意拖曳定位，可在設定中一鍵切換：

- **🧭 專業 HUD 科技儀表（預設·實用導向）**：  
  專為工程師與專注工作者設計。深色晶透圓形雷達，即時動態顯示實時總體額度數值（如 `88%`）、高精度霓虹進度環（青藍充足 / 金黃警戒 / 緋紅見底）與旋轉掃描燈。低調沉穩、零干擾，適合辦公與螢幕分享。
- **🐱 DeskCat 經典像素貓**：  
  經典 32×32 側面敲鍵盤像素小貓，具備三段情境動畫（元氣上班 `>70%`、焦躁冒汗 `20%~70%`、鍵盤趴睡 `<20%`）。
- **🖼️ 自訂虛擬寵物（Custom Avatar）**：  
  讓每位用戶自由更換為自己喜愛的虛擬寵物、動漫角色或個人吉祥物。支援 PNG、JPG 與動態 GIF。可分別為「充足」、「警戒」與「見底」三態上傳專屬圖片，亦可僅上傳 1 張通用圖片由程式自動附加警示震動與 `Zzz` 休息特效！

### 2. 🔍 零手動配置（Zero-Setup Auto-Discovery）
**不需要安裝 T3 Code**。直接沿用各家官方 CLI 的登入，不必另外輸入 API Key 或重新登入：
- **Claude Code**：掃描 `~/.claude`、`CLAUDE_CONFIG_DIR` 與 `~/.claude-<名稱>` 這類多帳號資料夾，唯讀讀取 `.credentials.json`，監控 5 小時與每週額度。
- **ChatGPT / Codex**：掃描 `CODEX_HOME`、`~/.codex` 與 `~/.codex-<名稱>`，唯讀讀取 `auth.json`。
- **Antigravity (Google / Gemini)**：執行官方的 `agy -p /usage --output-format json` 取得額度，完全不碰登入資料（agy 存在系統認證管理員裡）。只有在 agy 已登入時才會執行。
- **T3 Code（選配）**：有安裝時，會一併讀取 T3 的多帳號實例與顯示名稱。
- **其他資料夾**：在「設定 → 帳號 → 帳號資料夾」按「新增資料夾」。
- 偵測到哪些帳號、各自從哪裡來，會寫在 `%APPDATA%\t3-deskcat\deskcat.log`。

### 3. 🎯 智慧推薦與簡潔懸停提示（Smart Pick & Tooltip）
- **滑鼠懸停**：即時提示目前各家推薦使用帳號與剩餘百分比，例如：
  ```text
  Claude: Account-2 94% ｜ AG: Account-1 88%
  ```
- **單擊展開懸浮面板**：點擊小貓或系統匣圖示即可呼出半透明現代暗色面板。包含目前各帳號的重置倒數、即時進度條與視窗限制。面板失去焦點自動收合，亦可點擊右上角 📌 釘選固定。

### 4. ⚙️ 彈性額度計算與原生通知
- **評分模式自由切換**：
  - `各家最高可用帳號平均`（預設，推薦：代表目前你立刻能切換到的最佳戰力）
  - `所有帳號平均`（代表整體總量庫存水位）
- **Windows 原生推播通知**：當帳號低於警戒值、額度歸零見底、或是倒數結束重置恢復時，發送原生桌面通知。
- **開機自動啟動**：支援一鍵開啟 Windows 登入自動開機啟動。

---

## ❓ 常見問題

- **少了某個帳號？** 「設定 → 帳號」會列出每個帳號從哪裡讀到；不在預設位置的，按「新增資料夾」加進來。回報問題時，到「設定 → 一般 → 支援」按「複製診斷資訊」貼上即可（不含登入憑證）。
- **怎麼在手機上看？** 面板底下的「也能在手機上看額度」會帶你走四步：電腦裝 Tailscale、登入、手機裝 Tailscale、掃 QR code。
- **Antigravity 只看得到一個帳號？** 沒有 T3 Code 時是透過官方 `agy` CLI 查詢，agy 同一時間只登入一個帳號。要同時看多個，可搭配 T3 Code 的多帳號實例。
- **顯示「憑證已過期」？** DeskCat 不會自己刷新或改寫任何登入資料。用該帳號跑一次 Claude Code / Codex / Antigravity，就會自動更新。
- **安裝時跳出 SmartScreen 警告？** 安裝檔尚未做程式碼簽章。點「其他資訊」→「仍要執行」即可；也可以照下方步驟自行編譯。
- **手機頁面？** 預設關閉。需要電腦與手機都在同一個 Tailscale 網路，可在設定中開啟。
## 🔒 隱私與安全性保證

- **100% 本地運作（No Telemetry）**：程式不包含任何第三方數據收集、上報代碼或追蹤器。
- **唯讀保護（Read-Only）**：對於 Claude 及 Codex 的帳號憑證僅採取唯讀載入。
- **記憶體刷新**：對 Google Antigravity OAuth Token 的更新流程全數於記憶體（In-Memory）完成，絕不改寫本機原有設定檔。
- **開源透明**：所有程式碼皆公開於 GitHub，任何人皆可檢閱與自行編譯。

---

## 🚀 下載與安裝

### Windows 預先編譯安裝檔
前往 [GitHub Releases](https://github.com/b40609/t3-deskcat/releases/latest) 下載最新版本：
- **`T3 DeskCat_x.x.x_x64-setup.exe`**：標準 Windows 安裝程式（自動建立桌面捷徑與開始功能表項目）。

### 啟動後操作指引
1. **小貓位置**：啟動後會出現在主螢幕右下角工作列上方。
2. **拖曳移動**：滑鼠左鍵按住小貓即可拖曳到螢幕上的任何位置，放開後自動保存座標。
3. **展開面板**：點擊小貓或點擊 Windows 右下角系統匣（System Tray）的貓貓圖示。
4. **調整尺寸與設定**：在展開的面板中點選「設定」，即可透過滑桿即時縮放小貓大小、修改警示門檻與計算方式。

---

## 🛠️ 開發與編譯

如果你希望自行修改程式碼或從源碼編譯：

### 環境需求
- **Windows 10 / 11**（已安裝 WebView2 Runtime，通常系統自帶）
- **Node.js** 18+ 與 **npm**
- **Rust** 1.77+ 與 Cargo
- **Visual Studio C++ Build Tools**（含 MSVC 編譯器與 Windows 10/11 SDK）

### 1. 取得專案原始碼
```bash
git clone https://github.com/b40609/t3-deskcat.git
cd t3-deskcat
npm install
```

### 2. 開發模式執行
```bash
npm run tauri dev
```

### 3. 本地單元測試
```bash
cd src-tauri
cargo test
```

### 4. 建置生產安裝包
```bash
npm run tauri build
```
編譯完成的安裝程式將位於：  
`src-tauri/target/release/bundle/nsis/T3 DeskCat_<version>_x64-setup.exe`

---

## 📂 專案架構

```text
t3-deskcat/
├── .github/workflows/       # GitHub Actions 跨平台自動釋出流程
├── src/                     # 前端 Webview UI (TypeScript + Canvas)
│   ├── catSprite.ts         # 像素小貓逐幀繪製與狀態引擎 (Canvas 2D)
│   ├── panel.ts             # 展開式儀表板與即時設定介面邏輯
│   ├── pet.ts               # 小貓懸浮視窗、滑鼠拖曳與互動監聽
│   ├── styles.css           # 玻璃擬態 (Glassmorphism) 深色主題樣式
│   └── types.ts             # 前端資料結構定義
├── src-tauri/               # 後端原生引擎 (Rust + Tauri v2)
│   ├── src/
│   │   ├── discovery.rs     # T3 Code 憑證與帳號動態偵測器
│   │   ├── models.rs        # 額度模型、設定值結構與評分邏輯
│   │   ├── settings.rs      # 本地設定檔管理 (~/AppData/Roaming/t3-deskcat)
│   │   ├── providers/       # 各模型服務額度抓取器 (Claude / Antigravity / Codex)
│   │   └── lib.rs           # Tauri 命令、系統匣托盤與多視窗協同管理
│   ├── Cargo.toml           # Rust 依賴宣告
│   └── tauri.conf.json      # 視窗透明度、多視窗與打包配置
├── package.json
└── README.md
```

---

## 🤝 參與貢獻

歡迎提交 Issue 或 Pull Request！
1. Fork 本專案倉庫
2. 建立您的特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交您的變更 (`git commit -m 'feat: add amazing feature'`)
4. 推送至遠端分支 (`git push origin feature/amazing-feature`)
5. 發起 Pull Request

---

## 📄 授權條款

本專案採用 [MIT License](LICENSE) 條款開源。
