# AGENTS.md — t3-deskcat

## 本機建置與更新安裝檔（鐵律）

1. **禁止直接用 `cargo build --release` 編譯並複製執行檔**
   - Tauri v2 預設**不啟用** `tauri/custom-protocol`。直接跑 `cargo build --release` 編出來的 release binary 會連向 `devUrl`（`http://localhost:1420`），沒有開 Vite dev server 時打開會顯示 Edge WebView2 的「無法連線到此頁面 / `ERR_CONNECTION_REFUSED`」。
   - `src-tauri/build.rs` 與 `src-tauri/src/lib.rs` 已加入編譯期檢查，未啟用 `custom-protocol` 的 release 編譯會直接報錯中止。
   - **一律改用 `npm run deploy:local`**（會先清乾淨舊進程、執行 `npm run build:exe` = `tauri build --no-bundle` 重建前端 `dist/` 並以 `custom-protocol` 編譯嵌入資源、覆蓋 `%LOCALAPPDATA%\T3 DeskCat\t3-deskcat.exe` 並驗證 SHA256）。
   - 只想建置不安裝時跑 `npm run build:exe`。

2. **禁止在 agent 終端內直接啟動 `t3-deskcat.exe`**
   - 沙盒終端跑在隱藏桌面（`WinSta0\exebox-*`），從終端啟動 GUI 程式會畫在實體螢幕看不到的桌面，且會佔住 `tauri-plugin-single-instance` 鎖，導致使用者雙擊桌面捷徑完全沒反應。
   - 部署完成後確認 `Get-Process -Name t3-deskcat` 為 0，交由使用者從實體桌面捷徑開啟。
