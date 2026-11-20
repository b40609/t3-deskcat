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

### 1. 🎨 多彩なテーマ＆自由な自作ペット設定（Themes & Custom Avatar）
透過・枠なし・サイズ変更対応（48px〜128px、デフォルト 64px）、マルチモニター間で自由にドラッグ＆ドロップ可能：

- **🧭 プロフェッショナル HUD メーター（デフォルト・実用性重視）**：  
  エンジニアや集中作業向けに設計。透過ダークサークルにリアルタイム残枠（例：`88%`）、高精度ネオンリング（青色 充足 / 黄色 警戒 / 赤色 枯渇）、スキャンアニメーションを静かに表示。オフィスや画面共有時でも目立たず洗練された佇まいです。
- **🐱 DeskCat クラシックピクセル猫**：  
  横からキーボードを叩く懐かしの 32×32 ピクセルアート猫。3段階のアニメーション（通常作業 `>70%`、焦りタイピング `20%~70%`、キーボード就寝 `<20%`）。
- **🖼️ カスタムペット画像（ユーザーアップロード）**：  
  好みのキャラクターやペット画像（PNG / JPG / アニメーション GIF）を自由に設定可能。各状態ごとの専用画像はもちろん、1枚のお気に入り画像を登録するだけで自動的に緊張の微振動や就寝時の `Zzz` エフェクトが付与されます！

### 2. 🔍 完全自動のローカル検出（Zero-Setup）
**T3 Code は不要です。** 各公式 CLI のログインをそのまま利用するため、API キーの入力や OAuth の再認証は要りません：
- **Claude Code**：`~/.claude`、`CLAUDE_CONFIG_DIR`、`~/.claude-<名前>` のような複数アカウント用フォルダを走査し、`.credentials.json` を読み取り専用で解析。
- **ChatGPT / Codex**：`CODEX_HOME`、`~/.codex`、`~/.codex-<名前>` の `auth.json` を読み取り専用で解析。
- **Antigravity (Google / Gemini)**：公式の `agy -p /usage --output-format json` で取得し、ログイン情報には一切触れません。agy がログイン済みのときだけ実行します。
- **T3 Code（任意）**：インストールされていれば、そのマルチアカウント設定と表示名も取り込みます。
- 検出結果と取得元は `%APPDATA%\t3-deskcat\deskcat.log` に記録されます。

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
