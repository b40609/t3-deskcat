<div align="center">

# 🐾 T3 DeskCat

**Rust + Tauri v2 で構築された、常に最前面に表示されるデスクトップペット＆マルチアカウント AI 利用枠モニター**  
*T3 Code ユーザー向け：Claude、Antigravity、ChatGPT の複数アカウント残枠をリアルタイム監視*

[![GitHub release](https://img.shields.io/github/v/release/b40609/t3-deskcat?color=24C8DB&logo=github)](https://github.com/b40609/t3-deskcat/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078D6?logo=windows)](https://github.com/b40609/t3-deskcat/releases)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2.12-FFC131?logo=tauri)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-Edition%202021-DEA584?logo=rust)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[繁體中文](README.md) • [English](README_en.md) • [日本語](README_ja.md) • [简体中文](README_zh-CN.md)

---

</div>

## 💡 T3 DeskCat とは？

**T3 Code** を活用する開発者は、複数の AI サービスや複数アカウント（**Claude × 3、Antigravity × 3、ChatGPT / Codex × 1** など）を同時に運用することが一般的です。  
しかし、コーディングの途中で突然レート制限に達して作業が中断したり、CLI やブラウザで残りの利用枠を一つずつ確認するのは大きなストレスになります。

**T3 DeskCat** は、デスクトップの片隅でキーボードを叩きながら、あなたの残枠をそっと見守ります：
- **初期設定ゼロ**：T3 Code の設定とローカル認証情報を自動検出し、起動するだけですぐ使えます。
- **猫の表情が利用枠を反映**：枠が十分なら元気にタイピング、減ってくると冷や汗を流し、底をつくとキーボードで寝てしまいます。
- **最適アカウント推薦**：猫の上にマウスを乗せるだけで、今どのモデル・アカウントを使うべきか即座に分かります。
- **超軽量動作**：Rust + Tauri v2 ネイティブ実装により、メモリ消費は約 50MB、アイドル時の CPU 負荷はほぼ 0% です。

---

## ✨ 主な機能

### 1. 🐱 3段階のピクセルアニメーション
透過・枠なし・サイズ変更対応（48px〜128px、デフォルト 64px）、マルチモニター間で自由にドラッグ＆ドロップ可能：

| 状態 | アニメーション演出 | デフォルト条件 |
| :--- | :--- | :--- |
| **元気に作業 (Working)** | 青く光るモニターの前で軽快にキーボードを叩く | 総合スコア `> 70%` |
| **焦って冷や汗 (Sweating)** | 汗を飛ばし、湯気の立つコーヒーを横目に猛烈タイピング | 総合スコア `20% ~ 70%` |
| **枠切れ就寝 (Sleeping)** | 画面が消え、キーボードに突っ伏して寝息を立てる (`Zzz`) | 総合スコア `< 20%` または 0% |

### 2. 🔍 完全自動のローカル検出（Zero-Setup）
API キーを手動入力したり、面倒な OAuth 認証をやり直す必要はありません：
- **Claude Code**：ローカル認証情報を読み取り専用で解析し、5時間ウィンドウと7日間上限をリアルタイム監視。
- **Antigravity (Google / Gemini)**：メモリ内でのみアクセストークンを更新（ローカルの設定ファイルは一切書き換えません）。Gemini の主要枠（5時間 / 週間）を優先表示。
- **ChatGPT / Codex**：読み取り専用で認証状態を解析し、プライマリ／セカンダリのリセット時間を監視。

### 3. 🎯 スマート推奨＆ホバーツールチップ
- **マウスホバー**：今最も残枠があるおすすめアカウントと残量をワンライナーで表示：
  ```text
  Claude: Account-2 94% ｜ AG: Account-1 88%
  ```
- **クリックでダッシュボード展開**：猫またはタスクトレイアイコンをクリックすると、ダークガラス風のダッシュボードが表示され、詳細なリセットカウントダウンや進捗バーを確認できます（ピン留め 📌 も可能）。

### 4. ⚙️ 柔軟な計算設定とネイティブ通知
- **スコア計算モード切替**：
  - `各プロバイダーの最大値平均`（デフォルト：すぐに切り替えられる最大戦力を反映）
  - `全アカウントの平均`（全体的な残量の健全性を反映）
- **Windows ネイティブ通知**：残枠低下時、完全枯渇時、リセット復活時にデスクトップ通知でお知らせ。
- **自動起動**：Windows ログイン時の自動起動に対応。

---

## 🔒 セキュリティとプライバシー

- **テレメトリなし（No Telemetry）**：アクセス解析や外部へのデータ送信は一切行いません。
- **完全読み取り専用**：Claude および Codex のトークンファイルを書き換えることはありません。
- **メモリ内更新**：Google Antigravity のトークン更新はすべてメモリ上で行われ、ディスク上のファイルは変更されません。
- **オープンソース**：GitHub 上ですべてのソースコードを公開しています。

---

## 🚀 ダウンロードとインストール

### Windows インストーラー
[GitHub Releases](https://github.com/b40609/t3-deskcat/releases/latest) から最新版をダウンロードしてください：
- **`T3 DeskCat_x.x.x_x64-setup.exe`**：標準インストーラー（デスクトップショートカット自動生成）。

---

## 📄 ライセンス

本プロジェクトは [MIT License](LICENSE) のもとで公開されています。
