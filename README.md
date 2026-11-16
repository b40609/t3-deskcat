<div align="center">

# 🐾 T3 DeskCat · 月薪貓

**A lightweight, always-on-top Salary-Cat desktop pet & multi-account AI quota monitor built with Rust + Tauri v2.**  
*為 T3 Code 開發者打造的摸魚桌面寵物與多模型多帳號額度雷達（零手動綁定、無感常駐、三段像素動態）*

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

**T3 DeskCat（月薪貓）** 直接化身為一隻常駐在桌面邊緣的側面打字小貓：
- **零手動設定**：自動掃描 T3 Code 本機憑證，啟動即用。
- **神態反映額度**：小貓打字精力充沛代表額度充足；冒汗狂敲代表額度吃緊；趴在鍵盤睡覺代表額度見底。
- **最佳帳號智慧推薦**：滑鼠懸停即可知道目前各家最該使用哪一個帳號。
- **超低系統開銷**：基於 Rust + Tauri v2 原生架構，記憶體佔用僅約 50 MB，閒置 CPU 趨近於 0%。

---

## ✨ 核心特性

### 1. 🐱 三段像素打字動畫（反映整體額度狀態）
透明無邊框設計、支援自定義尺寸（48px ~ 128px，預設 64px）與滑鼠隨意拖曳定位：

| 狀態 | 動態表現 | 預設門檻條件 |
| :--- | :--- | :--- |
| **元氣上班 (Working)** | 螢光青藍螢幕前規律敲擊鍵盤，精力飽滿 | 綜合評分 `> 70%` |
| **趕工冒汗 (Sweating)** | 鍵盤狂敲＋冒汗＋冒熱氣咖啡杯，焦慮趕工 | 綜合評分 `20% ~ 70%` |
| **額度見底 (Sleeping)** | 螢幕暗下，整隻趴在鍵盤上打呼冒泡 (`Zzz`) | 綜合評分 `< 20%` 或歸零 |

### 2. 🔍 零手動配置（Zero-Setup Auto-Discovery）
自動讀取 T3 Code 現有配置與本機憑證檔，完全不需要重新手動輸入 API Key 或重跑 OAuth 登入流程：
- **Claude Code**：唯讀解析本機憑證，即時監控 5 小時動態視窗與 7 日每週額度。
- **Antigravity (Google / Gemini)**：自動讀取本機 token，僅在記憶體內部刷新臨時 Access Token（絕不竄改或寫入本機登入檔）。優先提取主要的 Gemini 5h / 週用量池，可選開啟次要池。
- **ChatGPT / Codex**：唯讀解析本機認證狀態，監控 Primary / Secondary 重置視窗。

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
│   ├── catSprite.ts         # 像素月薪貓逐幀繪製與狀態引擎 (Canvas 2D)
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
