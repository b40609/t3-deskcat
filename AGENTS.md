# AGENTS.md — t3-deskcat

## 本機建置與更新安裝檔（鐵律）

1. **禁止直接用 `cargo build --release` 編譯並複製執行檔**
   - Tauri v2 預設**不啟用** `tauri/custom-protocol`。直接跑 `cargo build --release` 編出來的 release binary 會連向 `devUrl`（`http://localhost:1420`），沒有開 Vite dev server 時打開會顯示 Edge WebView2 的「無法連線到此頁面 / `ERR_CONNECTION_REFUSED`」。
   - `src-tauri/build.rs` 與 `src-tauri/src/lib.rs` 已加入編譯期檢查，未啟用 `custom-protocol` 的 release 編譯會直接報錯中止。
   - **一律改用 `npm run deploy:local`**（會先清乾淨舊進程、執行 `npm run build:exe` = `tauri build --no-bundle` 重建前端 `dist/` 並以 `custom-protocol` 編譯嵌入資源、覆蓋 `%LOCALAPPDATA%\T3 DeskCat\t3-deskcat.exe` 並驗證 SHA256）。
   - 只想建置不安裝時跑 `npm run build:exe`。

2. **禁止在 agent 終端或工作排程器自動啟動 `t3-deskcat.exe`**
   - `npm run deploy:local` 只負責停止舊進程、建置嵌入資源、覆蓋 `%LOCALAPPDATA%\T3 DeskCat\t3-deskcat.exe` 並驗證 SHA256；部署完成後一律請使用者從桌面捷徑手動開啟。
   - 不要用 `Start-Process` 或 `explorer.exe <exe>` 啟動：2026-11-26 實測，前者被沙盒擋（存取被拒）；後者會另生一個留在終端 job 裡的 explorer，DeskCat 寫不了日誌、開不了手機連接埠，終端指令結束就被一起關掉，還可能佔住 `tauri-plugin-single-instance` 鎖讓使用者雙擊捷徑沒反應。
   - 不要透過 Windows 工作排程器（`Register-ScheduledTask` / `schtasks`）自動啟動：2026-11-27 00:19:35 實測，新建排程啟動剛編譯的無簽章 exe 會在 15 秒內觸發 Trend Micro Apex One 行為監控清理（`TSC_GENCLEAN`），直接中止進程、刪除排程工作並隔離安裝檔。
