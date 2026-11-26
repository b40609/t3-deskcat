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

3. **完工定義：前端改動要附「使用者實際設定下」的截圖才算完成**
   - 動到面板、手機頁或系統匣外觀（`src/*.ts`、`src/*.css`、`*.html`、`tray_icon.rs` 等）時，完工回報必須附截圖路徑，截圖要用使用者實際的顯示設定（主題、版面、亮暗、數字顯示）。實際設定在 `%APPDATA%\t3-deskcat\settings.json`，每次現讀，不要沿用舊報告寫的組合（2026-11-27 實測，使用者用的是 `glass` + `classic` + `dark` + `remaining`，和前一晚報告寫的 `default` + `dense` 不同）。
   - 做法：`npm run build` 之後跑 `npm run shot -- --out <資料夾>`（`scripts/shot-panel.mjs`）。它會讀真實設定的顯示欄位（不帶帳號私人欄位），用固定的假帳號（可用、快用完、用完、閒置、異常）以 Chromium 截桌面面板與設定頁、以 WebKit iPhone 15 截手機頁，並印出 JSON 檢查結果：各列的 class 與顏色、排序、設定選單、橫向溢位 = 0、輸入框字級 >= 16px、可捲動、沒有 page error；任一項不過就 exit 1。要看別的組合用 `--set panelTheme=default --set panelLayout=dense`。
   - 排序或分級改動，回報要附 `shot` 輸出的排序結果（`desktopOrder`），並說明和預期的差異。
   - 沒附截圖與檢查輸出，只能寫「已實作，未驗證」，不能寫「完成」，也不能把畫面驗證標成「卡在使用者」：同一份 bundle 在本機就能截。使用者要拍板的只有「喜不喜歡」，不是「有沒有照規格出現」。
   - 截圖的限制要寫明：headless 沒有 Windows 的 DWM Acrylic 毛玻璃，背景是純色；系統匣圖示不在截圖範圍，改動要靠 `cargo test` 的 `tray_icon` 測試。
   - 部署：`npm run deploy:local` 任何一步失敗都會印 `DEPLOY FAILED` 並 exit 1；只有看到 `Deployed and verified successfully` 而且 exit 0 才能回報已部署。
