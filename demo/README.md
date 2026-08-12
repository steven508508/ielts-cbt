# 示範站

<https://steven508508.github.io/ielts-cbt/>

GitHub Pages 只能放靜態檔案，跑不了 Node、MySQL 和 WebSocket。但這個專案的
前端沒有 build step，而且對後端的溝通全部收斂在 `public/js/api.js` 的一個
`fetch()`，所以只要在 `api.js` 載入之前把 `window.fetch` 換掉，前端一行都不用
改，跑的就是真正的 UI 程式碼。

## 什麼是真的、什麼是假的

| | 示範站 | 正式站 |
|---|---|---|
| 前端程式碼 | **原封不動**從 `public/` 複製 | 同一份 |
| 聽力／閱讀批改 | **真的** —— 直接用 `server/lib/answers.js`、`bands.js` | 同一份 |
| 分數換算 | **真的** —— 官方 raw→band 對照表 | 同一份 |
| 聽力音檔 | 真的音檔（Piper TTS 從逐字稿合成，19 分鐘） | 老師上傳的錄音 |
| 寫作評分 | 預先寫好的評語，不隨內容改變 | 每篇送 AI 批改 |
| 口說 | 錄好的示範對話，照真實 WebSocket 協定重播 | 跟 AI 考官全雙工即時對話 |
| 麥克風 | **完全不要求權限**（`getUserMedia` 回一條無聲音軌） | 真的錄音 |
| 資料 | 只在記憶體，重整就重來 | MySQL |
| 老師端 | 沒有 | 完整 |

口說那段刻意**不繞過**前端的音訊管線：考官的聲音一樣是以 PCM16 24kHz 的
base64 分塊送進 `speaking.js` 的 `playChunk()`，跟真的即時語音走同一條路。
mp3 只是傳輸格式，在瀏覽器裡解碼、重取樣之後才送出去。

## 檔案

```
demo/
  shim.js              假後端：攔 fetch，實作 30 幾個端點
  speaking-ws.js       假 WebSocket：重播口說腳本；順便擋掉麥克風權限
  speaking-script.json 口說的逐字稿、題卡、即時分數、最終評分
  writing-feedback.json 寫作的預寫評語
  banner.js            說明橫幅（會把考試畫面下緣往上收，不遮題號列）
  fixtures/            從真的伺服器錄下來的回應，用來對齊契約
  audio/               聽力四節 + 考官每一句（Piper 合成）
  images/              寫作 Task 1 圖表、聽力 Section 2 地圖
```

`fixtures/` 是拿真的伺服器跑一次學生流程錄下來的。假後端照著它回，
契約就不會是我猜的。

## 建置

```bash
npm run demo:build      # 組到 _site/
npm run demo:serve      # 組完順便開 http://localhost:8899
npm run test:demo       # 在真的瀏覽器裡跑一次
```

音檔與圖片是預先產好、進版控的，平常不用重跑。要重新合成：

```bash
pip install piper-tts
sudo apt install ffmpeg
npm run demo:audio      # 聽力 + 考官語音 + 兩張圖，約 10 分鐘
```

`_site/` 不進版控 —— 它整份是從 `public/` 複製來的，提交等於把前端存兩份，
而且遲早有人改了 `public/` 忘記重建。改由 `.github/workflows/pages.yml`
每次 push 自動建置、實測、部署。

## 加東西進去要注意

假後端漏接一個端點時，畫面上多半**不會壞掉**，只是那塊功能默默不動 ——
這正是這個專案最常見的失敗模式。所以 `shim.js` 對沒實作的路徑會回 501 並
`console.warn('[demo] 沒接住的請求')`，而 `test/browser/demoSite.mjs` 會把
任何一筆這種警告當成測試失敗。加新功能時照這個模式走。
