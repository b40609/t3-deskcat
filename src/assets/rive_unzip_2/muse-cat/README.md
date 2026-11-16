# Muse Cat — Rive 第一版

月薪貓桌寵的 Rive 版本，給 t3-deskcat（Tauri v2）用的動畫檔。
取代之前手刻 PIL GIF 的做法：狀態機、三態、透明底，全部在一個 `.riv` 裡。

## 檔案

- `scene.rml` — 場景原始碼（Rive Markup Language，純文字，可進 Git）
- `muse_work_512.png` / `muse_sweat_512.png` / `muse_sleep_512.png` — 三態貼圖（512px 透明）
- `Montserrat.ttf` — 睡覺時 "Z" 字的字型
- `build/preview_work.png` / `preview_sweat.png` / `preview_sleep.png` — 驗證截圖

## 狀態機

Artboard `MuseCat`（512×512，**沒有背景填色，透明**），state machine 叫 `Pet States`，
輸入是一個 ViewModel 數字 `quota`（0–100，預設 100）。

| quota | 狀態 | 動畫 |
| --- | --- | --- |
| ≥ 50 | Working | 上下小跳動（±6px，0.5 秒循環） |
| 20–49 | Sweating | 流汗圖靜止（不抖動） |
| < 20 | Sleeping | 呼吸放大 1.00→1.05（3 秒循環）＋ "Z" 字往上飄、淡入淡出 |

狀態切換有 300ms 交叉淡入淡出。quota 從 10 直接跳回 100 時，會先經過 Sweating 再進 Working（連鎖切換）。

## 驗證結果（2026-11-16，headless 截圖）

- `rive . --verify`：0 error、0 warning。
- 工作態 frame 1 vs frame 15：29.3% 像素不同，跳動看得見。
- `data quota=30` → 截圖與流汗原圖平均差 3.9（幾乎一樣）；`data quota=10` → 睡覺圖、眼睛閉上、"Z" 出現；呼吸 frame 30 vs frame 90：15.6% 像素變化。
- 注意：截圖工具會把透明底壓成深灰（`#1D1D1D`）才寫 PNG，`.riv` 本身沒有背景，進 Tauri 透明視窗後應為透明，實機再確認一次。

## 耳機空隙修正（2026-11-16 16:5x）

原本三張貼圖裡，耳機頭帶跟頭頂之間有一道白色月牙空隙：那是去背時被包在裡面的不透明白色，原畫的背景色，正確做法是把它變透明、讓背景透出來（跟 GitHub 頭像原圖一樣，耳機是浮在頭上的）。
第一版誤用頭的米色補上，變成一塊平平的前額，已改回透明：工作態 87 欄、流汗態 94 欄清成透明，最寬 29px，另清掉邊緣殘留的白點；睡覺態原本就貼著頭，不用修。
修圖腳本在上層目錄 `../fix_headphone_gap.py`（跑過就不用再跑），三態截圖已重截確認。

## 產出 .riv（需要你登入一次）

這台機器沒有 Rive 帳號，`rive . --publish` 會要求登入。做法：

```bash
cd t3-deskcat-muse-cat/rive/muse-cat
rive login          # 免費帳號即可，會開瀏覽器讓你登入
rive . --publish    # 產出 build/muse-cat.riv（857KB 左右）
```

免費帳號匯出的 `.riv` 開頭會播一段 Rive splash 畫面；要拿掉的話得付 Cadet 每月 $9。
不急著付，先用免費版確認動起來沒問題再決定。

## 接進 t3-deskcat

把 `build/muse-cat.riv` 放到 `src/assets/`，裝 `@rive-app/webgl2`，取代現在 `themeRenderer.ts`
裡用 Canvas `drawImage` 畫靜態 PNG 的做法：

```js
import { Rive } from "@rive-app/webgl2";

const r = new Rive({
  src: "muse-cat.riv",
  canvas: document.getElementById("cat-canvas"),
  stateMachine: "Pet States",
  autoplay: true,
  autoBind: true,
  onLoad: () => {
    r.resizeDrawingSurfaceToCanvas();
    // quota% 是你本來就有的總體額度百分比，直接餵進去就好
    r.viewModelInstance.number("quota").value = 88;
  },
});

// 額度變化時（本來更新 HUD 的地方順手更新）：
r.viewModelInstance.number("quota").value = newQuota;
```

不用再管 GIF、不用自己算幀，狀態切換交給 Rive。

## 本機開發

這份專案是用 Rive CLI 1.9.2 寫的。改完 `scene.rml` 後：

```bash
rive . --verify              # 編譯檢查
rive . --screenshot --advance=1   # 截一幀看外觀（需要 Xvfb，見下方）
```

`--screenshot` 需要 EGL context，這台 Linux VM 沒有裝系統級的 libEGL，
當時是從 Ubuntu 套件庫抓 `.deb` 解開後用 `LD_LIBRARY_PATH` + `__EGL_VENDOR_LIBRARY_DIRS`
餵給它，設定寫在 `~/bin/rive` / `~/bin/rive-xvfb` 兩個 wrapper 裡。
在 KAI 自己的 Windows 機器上裝 Rive CLI 就能直接用，不需要這些。
