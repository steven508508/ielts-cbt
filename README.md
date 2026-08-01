# IELTS 機考全面模擬考試系統

一套可以自行架設的雅思電腦化測驗（CBT）模擬平台。學生端 1:1 臨摹官方機考介面，
支援所有官方題型，口說是與 AI 考官的**即時語音對話**並即時評分，
考完自動產出仿官方風格成績單；教師端有完整的檔案、考試資料與成績管理服務。

- 後端：Node.js + Express + MySQL（口說即時語音走 WebSocket）
- 前端：原生 JavaScript（沒有打包工具，改了存檔重新整理就生效）
- AI：Claude / OpenAI / 任何自訂端點皆可，可分別指定文字、語音辨識、語音合成、即時對話

---

## 目錄

0. [用 Docker 安裝（推薦）](#用-docker-安裝推薦)
1. [手動安裝](#手動安裝)
2. [預設帳號](#預設帳號)
3. [設定 AI](#設定-ai)
4. [匯入題目](#匯入題目)
5. [支援的題型](#支援的題型)
6. [學生端：官方機考 1:1](#學生端官方機考-11)
7. [口說：即時語音對話與即時評分](#口說即時語音對話與即時評分)
8. [教師端管理服務](#教師端管理服務)
9. [批改與計分規則](#批改與計分規則)
10. [正式上線注意事項](#正式上線注意事項)
11. [專案結構](#專案結構)
12. [疑難排解](#疑難排解)

---

## 用 Docker 安裝（推薦）

Ubuntu Server 上最省事的方式。只需要 Docker 與 Docker Compose，資料庫會一起跑起來。

```bash
# 1. 安裝 Docker（Ubuntu 官方腳本，已裝過可跳過）
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# 2. 取得程式碼
git clone https://github.com/steven508508/ielts-cbt.git
cd ielts-cbt

# 3. 設定
cp .env.docker.example .env
nano .env          # 至少要改 DB_ROOT_PASSWORD、DB_PASSWORD、JWT_SECRET、ADMIN_PASSWORD
                   # JWT_SECRET 可以用 openssl rand -hex 32 產生

# 4. 啟動（第一次會建置映像檔，約 1–2 分鐘）
docker compose up -d

# 5. 看看跑起來沒
docker compose logs -f app
```

打開 `http://伺服器IP:3000` 即可。預設管理員帳號是 `.env` 裡的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`。

若 `.env` 裡設了 `SEED_DEMO=1`，第一次啟動會自動匯入內建的完整範例試卷與示範班級
（`teacher1` / `student1`~`student5`），方便馬上試考；正式上線建議改成 `0`。

### 日常維護

```bash
docker compose ps                 # 看狀態
docker compose logs -f app        # 看日誌
docker compose restart app        # 重啟
docker compose down               # 停止（資料保留）
docker compose down -v            # 停止並刪除所有資料 ⚠

# 更新到最新版
git pull && docker compose up -d --build

# 備份（資料庫 + 上傳的音檔／錄音）
docker compose exec -T db mysqldump -u root -p"$DB_ROOT_PASSWORD" --single-transaction ielts_cbt > backup-$(date +%F).sql
docker run --rm -v ielts-cbt_uploads:/data -v $PWD:/backup alpine tar czf /backup/uploads-$(date +%F).tar.gz -C /data .

# 還原
docker compose exec -T db mysql -u root -p"$DB_ROOT_PASSWORD" ielts_cbt < backup-2026-08-01.sql
```

資料存在兩個 Docker volume：`ielts-cbt_db_data`（資料庫）與 `ielts-cbt_uploads`
（聽力音檔、圖片、口說錄音）。`docker compose down` 不會刪掉它們。

### 搭配 Nginx + HTTPS

**口說錄音一定要有 HTTPS**，瀏覽器只在 `https://` 或 `localhost` 才給麥克風權限。
建議把 `.env` 的 `APP_PORT` 改成 `127.0.0.1:3000`（只讓本機連），再用 Nginx 反向代理：

```nginx
server {
    server_name ielts.example.com;

    client_max_body_size 200m;
    proxy_read_timeout   3600s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;   # 口說即時語音需要
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

然後 `sudo certbot --nginx -d ielts.example.com` 取得憑證即可。
`.env` 裡記得保持 `TRUST_PROXY=1`，系統才讀得到真實來源 IP。

---

## 手動安裝

不想用 Docker 的話：

### 需求

- Node.js 18 以上
- MySQL 5.7 以上（或 MariaDB 10.4 以上）

### 步驟

```bash
# 1. 安裝套件
npm install

# 2. 建立資料庫使用者（在 MySQL 裡執行一次）
#    CREATE DATABASE ielts_cbt CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
#    CREATE USER 'ielts'@'localhost' IDENTIFIED BY '你的密碼';
#    GRANT ALL PRIVILEGES ON ielts_cbt.* TO 'ielts'@'localhost';

# 3. 設定連線資訊
cp .env.example .env
#    打開 .env，填入 DB_USER / DB_PASSWORD，並把 JWT_SECRET 換成一長串亂碼

# 4. 建立資料表
npm run init-db

# 5.（可選）匯入內建的完整範例試卷與示範班級
npm run seed

# 6. 啟動
npm start
```

打開 <http://localhost:3000> 即可。

> `npm run init-db` 會自動建立資料庫（若不存在）與全部資料表。
> 之後每次 `npm start` 也會再檢查一次，所以升級版本時不需要手動改資料表。

---

## 預設帳號

執行 `npm run seed` 之後：

| 角色 | 帳號 | 密碼 | 能做什麼 |
|---|---|---|---|
| 管理員 | `admin` | `admin1234` | 全部功能，含系統設定與帳號管理 |
| 老師 | `teacher1` | `teach1234` | 試卷、題目匯入、AI 出題、學生、指派、成績 |
| 學生 | `student1`～`student5` | `ielts1234` | 考試、看自己的成績 |

**第一次登入後請立刻改密碼**（右上角齒輪 → 我的帳號）。

批次建立學生：老師後台 →「學生」→「批次新增」，一行一位貼上即可，
格式為 `姓名, 帳號, 密碼, 班級, 考生編號`（後面欄位可省略）。建立完可以直接下載帳密清單 CSV 發給學生。

---

## 設定 AI

到「系統設定 → AI 供應商」填寫。金鑰只存在你自己的資料庫，前端只看得到遮罩後的字串。

### 三種供應商

| 供應商 | 適用 | 要填什麼 |
|---|---|---|
| **Anthropic（Claude）** | 出題、寫作批改、口說評分品質最好 | API Key、Base URL、模型 |
| **OpenAI** | 同時提供 Whisper 語音辨識與 TTS 語音合成 | API Key、Base URL、模型 |
| **自訂端點** | Azure OpenAI、DeepSeek、Groq、Ollama、one-api、new-api、自架 LiteLLM… | 選 API 格式（OpenAI 相容 / Anthropic 相容）、Key、Base URL、模型 |

### 語音可以分開設定

口說模組需要兩種語音能力，兩者都可以獨立指定供應商：

- **STT（語音轉文字）**：把學生的錄音轉成逐字稿。Anthropic 沒有這項服務，請指定 OpenAI 或自訂端點。
- **TTS（文字轉語音）**：讓 AI 考官把題目念出來。同上。

**沒有語音 API 也能用**：系統會自動退回瀏覽器內建的
`SpeechSynthesis`（考官語音）與 `SpeechRecognition`（逐字稿，Chrome / Edge 支援）。
品質略差但完全免費，學校試用階段夠用。

設定完按「測試文字模型」與「測試語音」可以立刻驗證連線。

---

## 匯入題目

老師後台 →「匯入題目」，四種方式都支援，解析後會先顯示驗證結果，確認無誤才寫進資料庫。

### ① JSON

最完整、能表達所有題型。上傳 `.json` 或直接貼上。

- `samples/full-paper-academic.json` — 內建的完整範例試卷（聽力 40 題、閱讀 40 題、寫作 2 題、口說 3 部分）
- `samples/question-type-reference.json` — **每一種題型各一個範例**，複製需要的題組即可

### ② Excel / CSV

一列一題，適合大量整理。先到匯入頁按「下載 Excel 範本」，裡面有「說明」分頁與已填好的示範列。

主要欄位：

| 欄位 | 說明 |
|---|---|
| `module` | `listening` / `reading` / `writing` / `speaking` |
| `section` | 第幾個 section（數字），同一節填一樣的值 |
| `audio` / `passage` / `passage_title` | 聽力音檔網址、閱讀文章與標題（同一節只需填一次） |
| `group` | 題組編號，同一組（共用指示語與選項）填一樣的值 |
| `type` | 題型代碼，見下方表格 |
| `instructions` | 指示語，同一題組只需填第一列 |
| `word_limit` | 填空題字數上限 |
| `options` | 選項，用 `\|\|` 分隔，例如 `A. 文字 \|\| B. 文字` |
| `body_html` | 填空版面，用 `[[題號]]` 當空格 |
| `number` / `question` / `answer` / `explanation` | 題號、題目、答案、解析 |

答案有多種寫法用 `//` 分隔（`Bradfield // Bradfeild`），括號代表可有可無（`(the) north gate`）。

### ③ 貼上原文 + AI 解析

把 Word / PDF 複製出來的題目（就算排版跑掉也沒關係）整段貼上，AI 會判斷題型、
重建表格與空格、對應答案卷，轉成系統格式。**轉完務必人工檢查**，AI 不確定的地方會列在「提醒」裡。

### ④ 媒體庫

聽力音檔、圖表、地圖先在「媒體庫」上傳，系統會給一個網址（例如 `/uploads/audio/xxx.mp3`），
把它貼到題目的 `audio` / `image` 欄位即可。點一下網址就會複製到剪貼簿。

### AI 出題

「AI 出題」頁可以：

- **單一題組** — 指定科目、題型、主題、難度、題數，可以順便產生文章／聽力逐字稿；
  也可以貼上你自己的文章，讓 AI 只依這段內容出題（答案保證在文章裡找得到）
- **整份試卷** — 一次產生四科完整試卷（會花 2–5 分鐘、消耗較多額度）

產出的題目可以直接存成試卷、存進題庫，或下載 JSON 再手動調整。

---

## 支援的題型

涵蓋 IELTS 官方全部題型：

| 代碼 | 中文 | 對應的官方題型 |
|---|---|---|
| `mcq_single` | 單選題 | Multiple choice |
| `mcq_multi` | 多選題 | Multiple choice（Choose TWO/THREE letters） |
| `tfng` | T/F/NG | Identifying information |
| `ynng` | Y/N/NG | Identifying writer's views/claims |
| `matching` | 配對題 | Matching information / headings / features / sentence endings |
| `gap_fill` | 填空（自行輸入） | Form / Note / Table / Flow-chart / Summary / Sentence / Diagram label completion |
| `gap_fill_bank` | 填空（從清單挑） | Summary completion with word list |
| `short_answer` | 簡答題 | Short-answer questions |
| `label_image` | 圖表標示 | Plan / map / diagram labelling |
| `writing_task` | 寫作 | Task 1（Academic 圖表 / GT 書信）、Task 2 |
| `speaking_part` | 口說 | Part 1 / Part 2 題卡 / Part 3 |

版面型題目（表格、筆記、流程圖、摘要）統一用 `bodyHtml` + `[[題號]]` 表達，
所以官方那些「填在表格裡」「填在流程圖裡」的變化型都能忠實重現。

單選題每一題可以有自己的 `options`；配對題與選字填空則是整個題組共用一份選項清單。

---

## 學生端：官方機考 1:1

考試畫面（`public/css/cbt.css` + `public/js/exam.js`）是照著官方 computer-delivered IELTS
做的，位置、流程、互動都盡量一致：

**開場流程**

1. **Confirm your details** — 確認姓名、考生編號、試卷與 Academic／General。
2. **科目清單** — 一次考一科。
3. **Sound check** — 聽力開始前的耳機測試，可播測試音與試聽音檔前 4 秒。

**考試畫面**

| 位置 | 內容 |
|---|---|
| 頂列左 | 考生姓名 — 考生編號 |
| 頂列右 | `🕐 XX minutes left` 倒數、**Hide**（隱藏計時器）、**Help**、**Settings** |
| 指示語帶 | `Part 1 — Questions 1–10` 與該節指示語 |
| 主畫面 | 聽力＝單欄；閱讀＝左右分割（中間可拖曳）；寫作＝左題目右編輯器 |
| 底部左 | **Review** 核取方塊（標記目前這題稍後檢查） |
| 底部中 | Part / Passage 分組的題號列，**目前這一段展開、其他段收合成 `Part 2 (0/10)`** |
| 底部右 | `◀ ▶` 上一題／下一題、結束這一科 |

**題號狀態**：深色實心＝已作答、外框＝目前這題、右上橘點＝已標記 Review。

**Settings（官方的無障礙設定）**

- 文字大小：Standard / Large / Extra large
- 配色：標準（白底黑字）／黃底黑字／黑底黃字／黑底白字
- 設定存在瀏覽器，下次考試自動沿用

**螢光筆與註記**：在文章或題目上選取文字後按**滑鼠右鍵**，跳出
`Highlight` / `Notes` / `清除這一段` / `清除全部畫線` 選單，和官方一樣。
加了註記的畫線會變色，點一下可以重新編輯。

**其他官方行為**

- 聽力音檔只播一次、不能倒轉；播完自動進入下一個 Part；畫面上有音量控制。
- 剩 10 分鐘、5 分鐘、1 分鐘時跳出提醒視窗。
- 時間到自動收卷，並顯示該科的結束畫面。
- **計時由伺服器控制**：關掉分頁時間照樣走，重新進入會接續剩餘時間，不會重置。
- 鍵盤 `←` `→` 可以上下題。
- 系統會記錄「離開考試視窗的次數」，老師可以當作考試紀律的參考。
- 答案每秒自動儲存。

---

## 口說：即時語音對話與即時評分

口說有兩種模式，系統會**自動偵測**目前設定能不能跑即時對話：

### ① 即時語音對話（有設定 Realtime 端點時）

真正的即時對話，不是「念題→錄音→上傳」：

- 你直接開口說話就好，**不需要按任何按鈕**；停頓一下考官就會接話。
- **可以打斷考官**（barge-in）—— 你一出聲，考官的語音會立刻停下來聽你說。
- 逐字稿邊說邊出現，考官會依你的回答自然追問。
- Part 2 的 1 分鐘準備與 2 分鐘長回答由伺服器計時控制，時間到考官會說 "Thank you." 並收尾。
- 每 3 輪更新一次四大標準的即時分數，測驗一結束立刻算出正式分數。

技術上是 `瀏覽器 ─(PCM16 24kHz)→ 本伺服器 ─→ Realtime 模型`：
API 金鑰只留在伺服器端，不會外流到瀏覽器。整場對話另外用 MediaRecorder 備份成一個
音檔，老師事後可以聆聽。

**需要什麼**：一個 OpenAI 相容、提供 `/realtime` WebSocket 端點的模型。
到「系統設定 → AI → 即時對話模型」填模型名稱（預設 `gpt-4o-realtime-preview`）。

### ② 語音問答（沒有 Realtime 端點時的備援）

考官用 TTS 念題（或瀏覽器內建語音），學生按麥克風錄音、說完再按一次，
系統轉成逐字稿後繼續下一題。每答完一題也會更新一次即時分數。
這個模式完全免費也能跑（瀏覽器內建的語音合成與語音辨識）。

### 教師即時監看

老師後台的「即時監看」頁會列出最近 2 小時內進行過口說測驗的學生，
每 4 秒更新一次：目前在第幾個 Part、已回答幾輪、AI 給出的即時四項分數與一句評語，
也可以直接打開逐字稿。

> **麥克風需要 HTTPS**。瀏覽器只允許 `https://` 或 `http://localhost` 使用麥克風。
> 校內部署請務必套 HTTPS。

---

## 教師端管理服務

### 檔案管理（`檔案` 分頁）

- 批次上傳音檔與圖片，可指定**資料夾**與標籤
- 依類型、資料夾、關鍵字搜尋
- 每個檔案顯示**被哪幾份試卷使用**；沒被任何試卷引用的會標成「沒用到」
- 批次移動資料夾、批次刪除
- 刪除仍在使用中的檔案會先被攔下來，需要再次確認才會強制刪除
- 點網址即複製，直接貼到題目的 `audio` / `image` 欄

### 考試資料管理（`資料管理` 分頁）

**總覽與清理**

- 資料庫大小、上傳檔案大小（音檔／圖片／口說錄音分開統計）
- 各資料表筆數、最舊的成績日期、各月考試量分佈
- 「沒有被任何試卷使用的媒體檔」統計

**自動清理設定**（每一項填 0 = 永久保留）

| 設定 | 說明 |
|---|---|
| 成績保留（月） | 超過就連同作答、作文、錄音一起刪除 |
| 口說錄音保留（月） | 只刪音檔，逐字稿與分數保留 |
| 未完成考試保留（天） | 開始了卻沒交卷的場次 |
| AI 呼叫紀錄保留（天） | 除錯用的日誌 |
| 未使用媒體檔保留（天） | 沒有任何試卷引用的檔案 |
| 每天執行時間 | 0–23 點，伺服器時間 |

按 **🔍 試算** 會列出「會刪掉什麼、幾筆、釋放多少空間」但不真的動手；
確認沒問題再按 **⚠ 立即執行清理**。也可以開啟每天自動執行。

**成績管理**

- 依日期區間、班級、試卷、狀態、「幾個月以前」篩選
- 勾選批次 **封存／取消封存／刪除**
- **沒有勾選任何一列時，批次動作會套用到目前的篩選條件** ——
  例如選「24 個月以前」再按刪除，就會清掉兩年前的所有成績
- 刪除超過 20 筆會要求二次確認；只有管理員能刪除
- 匯出 CSV（含 BOM，Excel 開啟不亂碼）

**試卷管理**

- 顯示每份試卷的考試紀錄數、指派數、內容大小
- 批次發布／取消發布／封存／刪除
- **完整備份**：把一份試卷連同所有考試紀錄、作答、作文、口說、成績匯出成一個 JSON
- 刪除還有成績的試卷會先攔下來提醒

**維護紀錄**：所有清理與批次刪除都會留下紀錄（時間、動作、筆數、釋放空間、執行者）。

### 權限

| 動作 | 老師 | 管理員 |
|---|---|---|
| 檢視管理頁、封存、匯出、備份 | ✓ | ✓ |
| 上傳／移動／刪除媒體檔 | ✓ | ✓ |
| 刪除成績、刪除試卷 | ✗ | ✓ |
| 修改保留政策、實際執行清理 | ✗ | ✓ |

---

## 批改與計分規則

### 聽力 / 閱讀（自動）

比對規則盡量貼近官方：

- 大小寫、句尾標點、前後空白一律忽略
- 標準答案可以寫多個；括號內文字視為可有可無
- **超過字數限制一律不給分**（官方規則）
- 可在系統設定開關：英美拼法差異（colour = color）、連字號與空白互通（well-known = well known）、縮寫（don't = do not）
- 多選題一題佔多個題號，選對一個給一分；超選則該題組零分

原始分換算 Band 使用業界通用對照表（聽力、Academic 閱讀、General 閱讀各一份），
**老師可以在「系統設定 → 原始分 → Band 對照表」自行修改**。
題數若不是 40 題，系統會等比例換算後再查表。

### 寫作（AI 或人工）

依官方四大評分標準（Task Achievement/Response、Coherence and Cohesion、
Lexical Resource、Grammatical Range and Accuracy）各給 0–9 分，**Task 2 權重是 Task 1 的兩倍**。

AI 回饋包含：各項給分理由與原文引述、逐句修改對照表、用字升級建議、
Band 8–9 範文，以及具體的練習建議。老師可以在成績頁隨時手動覆蓋分數。

### 口說（AI 或人工）

依 Fluency and Coherence、Lexical Resource、Grammatical Range and Accuracy、
Pronunciation 四項給分，並附語速統計、逐題錄音與逐字稿。

> 只有逐字稿時，發音分數是依語速、填充詞、自我修正等線索推估的，AI 會在評語中註明。
> 要精準評發音建議改用人工評分模式。

### 總分

四科平均後採半分制四捨五入（`.25` 進到 `.5`、`.75` 進到整數），與官方一致，並附 CEFR 對照。

---

## 正式上線注意事項

- **改掉 `JWT_SECRET`**，換成一長串隨機字元（`openssl rand -hex 32`），否則任何人都能偽造登入。
  用 Docker 時沒設定會直接讓 compose 啟動失敗，就是為了避免忘記。
- 登入有速率限制：同一個 IP 十分鐘內失敗 20 次就會被暫時擋下。
- **套上 HTTPS**（Nginx / Caddy 反向代理 + Let's Encrypt）。口說錄音必須有 HTTPS。
- Nginx 反向代理時記得放寬上傳大小，並**打開 WebSocket 轉發**（口說即時對話需要）：

  ```nginx
  client_max_body_size 200m;
  proxy_read_timeout 3600s;

  location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade    $http_upgrade;   # WebSocket
      proxy_set_header Connection "upgrade";       # WebSocket
      proxy_set_header Host       $host;
      proxy_set_header X-Real-IP  $remote_addr;
  }
  ```
- 用 `pm2` 或 `systemd` 常駐：`pm2 start server/index.js --name ielts`
- 定期備份：MySQL 資料庫 + `uploads/` 資料夾（音檔、圖片、口說錄音都在裡面）。
- AI 額度：一場四科考試的 AI 批改大約是 2 次寫作 + 1 次口說的呼叫。
  班級人數多時建議先用「AI 批改一部分、老師抽查」的模式，或把寫作設成人工批改。
- 本系統產出的成績單標示為模擬測驗，**不是也不能當作 IELTS 官方成績**。

---

## 專案結構

```
ielts-cbt/
├── server/
│   ├── index.js              Express 入口
│   ├── config.js             設定讀取（.env）
│   ├── db.js                 MySQL 連線池、自動建表
│   ├── schema.sql            資料表定義
│   ├── lib/
│   │   ├── paper.js          試卷結構、題型登錄表、驗證
│   │   ├── answers.js        答案正規化與比對
│   │   ├── bands.js          分數對照表與換算
│   │   ├── grade.js          批改流程
│   │   ├── ai.js             AI 供應商抽象層（chat / STT / TTS）
│   │   ├── aiTasks.js        出題、解析、寫作批改、口說評分與即時評分的提示詞
│   │   ├── realtime.js       口說即時語音 WebSocket 中繼與考官流程狀態機
│   │   ├── retention.js      資料保留政策與自動清理
│   │   └── tabular.js        Excel / CSV 匯入與範本產生
│   ├── routes/               auth, users, tests, importer, media, exam,
│   │                         speaking, results, ai, manage
│   └── scripts/              initDb.js, seed.js
├── public/
│   ├── index.html
│   ├── css/
│   │   ├── ielts.css         入口網站（登入、後台、成績單）
│   │   └── cbt.css           考試畫面（仿官方機考，含高對比配色）
│   └── js/                   api, ui, exam, speaking, results, admin, app
├── samples/                  範例試卷與題型範本
├── test/
│   ├── unit.test.js          單元測試（批改、換算、驗證、匯入）
│   └── e2e.js                端對端測試（實際跑完一整場考試 + 管理服務）
├── docker/entrypoint.sh      容器啟動流程
├── Dockerfile
├── docker-compose.yml
├── .env.docker.example       Docker 部署的設定範本
└── uploads/                  音檔、圖片、口說錄音
```

### 測試

```bash
npm test                # 單元測試（31 項：批改、換算、驗證、匯入）
npm start               # 另開一個終端機
node test/e2e.js        # 端對端測試（83 項）：登入 → 作答 → 交卷 → 批改 → 成績單
                        # → 老師改分 → 檔案管理 → 成績批次操作 → 保留政策與清理
```

---

## 疑難排解

**啟動時顯示「無法連線到 MySQL」**
檢查 `.env` 的 `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`，以及 MySQL 服務是否已啟動。
若 MySQL 8 出現認證錯誤，可執行
`ALTER USER 'ielts'@'localhost' IDENTIFIED WITH mysql_native_password BY '密碼';`

**匯入時說「bodyHtml 缺少空格」**
`bodyHtml` 裡的 `[[題號]]` 必須和該題組 `questions` 的 `number` 完全一一對應，不能多也不能少。

**聽力沒有聲音**
確認該 section 的 `audio` 欄位有填，而且路徑是媒體庫給的網址（`/uploads/audio/...`）。
瀏覽器會擋自動播放，畫面上會顯示「點一下開始播放」，讓學生點一下即可。

**口說按了麥克風沒反應**
需要 HTTPS 或 localhost，且要在瀏覽器允許麥克風權限。可先按「測試麥克風」確認。

**口說變成「語音問答」而不是即時對話**
表示系統偵測不到可用的 Realtime 端點。檢查三件事：
① 系統設定裡的語音供應商是 OpenAI 或自訂端點（Anthropic 沒有 Realtime）；
② 「即時對話模型」填了正確的模型名稱；
③ 反向代理有打開 WebSocket 轉發（見上方 Nginx 設定）。
測驗開始時如果連線失敗，畫面會顯示原因並自動退回問答模式，不會卡住考試。

**清理刪錯東西了怎麼辦？**
刪除無法復原。所以請養成習慣：先按「試算」確認清單，再執行；
重要的試卷與成績可以先用「試卷管理 → 完整備份」匯出一份 JSON 留底。

**交卷後一直顯示「批改中」**
表示 AI 批改失敗（通常是沒設定金鑰或額度用完）。聽力與閱讀的成績仍然正常。
到「系統設定」按「測試文字模型」找出原因，修好之後在成績頁按「重新批改」即可；
或改用老師人工評分。

**AI 出題的題目品質不穩**
把主題寫具體一點、指定難度，或先貼上自己的文章讓 AI 只依該文出題。
AI 產生的題目一律建議人工校對後再指派給學生。

---

## 授權

MIT
