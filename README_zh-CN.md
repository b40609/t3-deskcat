<div align="center">

# 🐾 T3 DeskCat

**基于 Rust + Tauri v2 构建的轻量级置顶桌面宠物与多账号 AI 额度监控雷达**  
*专为 T3 Code 开发者打造：一键免配置实时监控 Claude、Antigravity、ChatGPT 多模型多账号剩余额度*

[![GitHub release](https://img.shields.io/github/v/release/b40609/t3-deskcat?color=24C8DB&logo=github)](https://github.com/b40609/t3-deskcat/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078D6?logo=windows)](https://github.com/b40609/t3-deskcat/releases)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2.12-FFC131?logo=tauri)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-Edition%202021-DEA584?logo=rust)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[繁體中文](README.md) • [English](README_en.md) • [日本語](README_ja.md) • [简体中文](README_zh-CN.md)

---

</div>

## 💡 为什么需要 T3 DeskCat？

作为 **T3 Code** 的重度用户，我们经常会同时订阅并配置多个 AI 账号（如 **Claude × 3、Antigravity × 3、ChatGPT / Codex × 1**）。  
过去，在写代码途中经常遇到额度用尽被迫中断，或者需要繁琐地打开各个网页与终端反复查看剩余用量。

**T3 DeskCat** 化身为一只安静趴在屏幕右下角敲击键盘的像素小猫：
- **零手动配置**：自动扫描并读取 T3 Code 的本地凭据，启动即用。
- **神态反映额度**：满血额度时神采奕奕打字；额度吃紧时疯狂冒汗赶工；额度归零时直接趴在键盘上呼呼大睡。
- **智能推荐账号**：鼠标悬停在猫咪上方，一秒知道当前各家最充裕的账号。
- **极致轻量**：基于 Rust + Tauri v2 原生架构，内存占用仅约 50 MB，闲置 CPU 开销接近 0%。

---

## ✨ 核心特性

### 1. 🎨 多元外观风格与自由自订虚拟宠物（Themes & Custom Avatar）
透明无边框窗口、支持自由拖拽以及滑块缩放尺寸（48px ~ 128px，默认 64px）：

- **🧭 专业 HUD 科技仪表（默认·实用专注）**：  
  专为工程师与专注工作场景打造。深色晶透圆形雷达，实时动态渲染总额度数值（如 `88%`）、高精度霓虹进度环（青蓝充足 / 黄金警戒 / 猩红见底）与旋转扫描灯。低调沉稳、无干扰，非常适合办公及屏幕共享。
- **🐱 DeskCat 经典像素猫**：  
  经典的 32×32 侧面敲键盘像素小猫，具备三段情境动画（元气上班 `>70%`、焦虑赶工 `20%~70%`、键盘趴睡 `<20%`）。
- **🖼️ 自定义虚拟宠物（用户自由上传）**：  
  允许用户自由更换为自己喜欢的宠物、动漫角色或个性头像（支持 PNG、JPG、动态 GIF）。可为三种状态分别设置专属图片，也可仅上传 1 张通用图片，由程序自动赋予焦躁微震与 `Zzz` 休息特效！

### 2. 🔍 零配置本地自发现（Zero-Setup Auto-Discovery）
无需重新输入 API Key 或重新登录 OAuth，自动解析现有 T3 Code 配置：
- **Claude Code**：只读解析本地凭据，实时监控 5 小时动态滚动窗口与 7 天周额度。
- **Antigravity (Google / Gemini)**：仅在内存中刷新临时 Token（绝不修改磁盘本地配置），优先展示主力 Gemini 5h 与周限额池。
- **ChatGPT / Codex**：只读解析认证信息，监控 Primary / Secondary 重置窗口。

### 3. 🎯 智能推荐与极简悬停提示
- **鼠标悬停**：精炼展示当前各服务推荐使用的最佳账号与剩余百分比：
  ```text
  Claude: Account-2 94% ｜ AG: Account-1 88%
  ```
- **单击展开面板**：点击猫咪或系统托盘图标，即可展开深色毛玻璃现代仪表盘，查看倒计时与详细进度条（支持 📌 钉选固定）。

### 4. ⚙️ 自定义算法与原生通知
- **评分模式**：支持在「各家最高可用账号平均」（默认）与「所有账号平均」之间一键切换。
- **Windows 原生通知**：支持在额度过低、账号归零以及倒计时结束额度重置时发送 Windows 原生桌面弹窗通知。
- **开机自启**：支持在设置中开启开机随系统启动。

---

## 🔒 隐私与安全承诺

- **无任何遥测收集（No Telemetry）**：不包含任何第三方分析代码或数据追踪。
- **严格只读保护**：对 Claude 与 Codex 本地凭证仅做读取，绝不修改。
- **内存安全刷新**：Google 临时 Token 刷新全程在内存完成，不修改原文件。
- **完全开源**：全部代码托管于 GitHub，透明公开。

---

## 🚀 下载与安装

### Windows 安装包
前往 [GitHub Releases](https://github.com/b40609/t3-deskcat/releases/latest) 下载最新版本：
- **`T3 DeskCat_x.x.x_x64-setup.exe`**：标准 Windows 安装包（自动生成桌面快捷方式）。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 许可证开源。
