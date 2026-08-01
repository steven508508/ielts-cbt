# IELTS 機考全面模擬考試系統

[![CI](https://github.com/steven508508/ielts-cbt/actions/workflows/ci.yml/badge.svg)](https://github.com/steven508508/ielts-cbt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)

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
4. [匯入題目 / AI 出題 / 題庫](#匯入題目)
5. [支援的題型](#支援的題型)
6. [老師可自訂的考試規則](#老師可自訂的考試規則)
7. [學生端：官方機考 1:1](#學生端官方機考-11)
8. [口說：即時語音對話與即時評分](#口說即時語音對話與即時評分)
9. [教師端管理服務](#教師端管理服務)
10. [批改與計分規則](#批改與計分規則)
11. [正式上線注意事項](#正式上線注意事項)
12. [專案結構](#專案結構)
13. [疑難排解](#疑難排解)

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

# 4. 啟動（第一次會建置映像檔，約 1–3 分鐘）
docker compose up -d --build

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

---

## 成員管理

後台的「**成員**」頁可以管理所有帳號 —— 管理員、老師、學生都在同一個地方，
上方分頁可以只看某一種角色，也能用姓名／帳號／Email／考生編號搜尋。

### 誰能做什麼

| 動作 | 老師 | 管理員 |
|---|---|---|
| 新增學生、改學生資料、重設學生密碼 | ✓ | ✓ |
| 停用／啟用學生 | ✓ | ✓ |
| 新增老師或管理員 | ✗ | ✓ |
| 修改老師或管理員 | ✗ | ✓ |
| **刪除任何成員** | ✗ | ✓ |

### 停用 vs 刪除

- **停用**：帳號不能登入，但成績、作答、錄音全部保留，隨時可以再啟用。
  學生畢業、老師離職建議用這個。
- **刪除**：連同這個人的**所有考試紀錄、逐題作答、作文、口說錄音**一起永久移除，無法復原。
  按下刪除時會先顯示「會失去幾場考試、幾筆指派」，並提供「改用停用」的選項。
  他建立過的試卷不會被刪，只是「建立者」欄位變成空白。

刪除會寫進維護紀錄（資料管理 → 維護紀錄），磁碟上的口說錄音也會一併清掉，不會留下孤兒檔案。

### 防呆

- 不能刪除或停用**自己**的帳號
- 不能刪除、停用或降級**系統裡最後一位啟用中的管理員** —— 否則沒有人能再進入後台
- 批次刪除超過 10 位會要求二次確認
- 帳號重複會被擋下

### 批次建立學生

「批次新增學生」可以一行一位貼上名單，格式為
`姓名, 帳號, 密碼, 班級, 考生編號`（後面欄位可省略；沒填帳號會自動產生，沒填密碼預設 `ielts1234`）。
建立完可以直接下載帳密清單 CSV 發給學生。

### 從指令列救援

管理員把自己鎖在外面時，用伺服器上的工具處理：

```bash
docker compose exec app node server/scripts/resetPassword.js --list
docker compose exec app node server/scripts/resetPassword.js admin 新的密碼
```

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

### 素材（文章／音檔／圖片）

題目只是一半 —— 閱讀要有文章、聽力要有音檔、地圖題要有圖，缺了學生端就會開天窗。
系統在三個地方幫你盯著：

1. **存檔時就講** — 任何一種匯入或 AI 出題，只要存進去的試卷缺文章或音檔，
   存完會立刻跳出提醒，而不是等學生開始考試才發現
2. **清單上標出來** — 試卷管理頁的「素材」按鈕會顯示 `素材 ⚠2`，代表有兩節缺東西
3. **「素材」按鈕可以直接補** — 點下去就能逐節填文章、音檔網址、圖片、逐字稿。
   **只動素材、不碰題目與答案**，所以不必擔心改壞題號

文章可以直接貼純文字，系統會自動補成段落；貼 HTML 也可以（`<p> <table> <img>` 等排版標籤都保留）。

### AI 出題

「AI 出題」頁可以：

- **單一題組** — 指定科目、題型、主題、難度、題數，可以順便產生文章／聽力逐字稿；
  也可以貼上你自己的文章，讓 AI 只依這段內容出題（答案保證在文章裡找得到）
- **整份試卷** — 一次產生四科完整試卷（40+40 題、兩篇寫作、完整口說）

產出的題目可以直接存成試卷、**存進題庫**，或下載 JSON 再手動調整。

#### 整份試卷是怎麼跑的

不是一個請求要 AI 吐出整份試卷 —— 那個輸出量三萬 token 起跳，幾乎必定撞上逾時。
系統把它拆成 **9 段**依序產生：

| 段 | 內容 |
|---|---|
| 1–4 | 聽力 Section 1–4（各 10 題 + 完整逐字稿） |
| 5–7 | 閱讀 Passage 1–3（各 13–14 題 + 完整文章） |
| 8 | 寫作 Task 1 + Task 2（含 band 8–9 範文） |
| 9 | 口說 Part 1–3 |

實作上是一個**背景工作**：按下按鈕後伺服器立刻回應，實際產生在背景進行，
網頁每 2.5 秒問一次進度並顯示到第幾段。所以：

- **可以關掉頁面**去做別的事，回到「AI 出題」頁會自動接回進度
- 不會受反向代理 `proxy_read_timeout` 或 **Cloudflare 橘雲 100 秒硬上限**影響
- 任何一段失敗會自動重試一次；仍然失敗時，**其餘八段照樣保留**，
  失敗畫面上按「取回已完成的部分」就能存成草稿試卷，再手動補那一段
- 每個人同時只能有一份在產生中（避免重複點擊白燒額度）
- 整份大約 3–8 分鐘，視模型速度而定

單段的逾時預設 180 秒，自架的慢模型可以在 `.env` 調整 `AI_TIMEOUT_MS`。

### 題庫

導覽列的「題庫」頁把所有存起來的題組收在一起，方便跨試卷重複使用。

- **來源** — AI 出題按「存進題庫」、匯入時收進來的題組，或手動經 API 新增
- **篩選** — 依科目、題型、來源篩選，或用關鍵字搜尋主題、標籤與題目內容
- **預覽** — 看完整題幹、選項、標準答案、解析與文章／逐字稿
- **標籤** — 隨時修改主題、難度、標籤，方便日後找回來
- **組卷** — 勾選任意幾個題組後按「加入試卷」，可以併進現有試卷或直接組成一份新試卷。
  題號會**自動接續**在既有題目後面，不會撞號
- **刪除** — 單筆或批次刪除；已經放進試卷的題目不受影響（題庫存的是副本）

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

## 老師可自訂的考試規則

在「指派考試」頁設定，**每一次指派都可以不一樣** —— 同一份試卷可以給 A 班標準時間、
給 B 班加時、給某位學生開監考模式。所有設定都由伺服器把關，學生改前端沒有用。

### ⏱ 考試時間

| 設定 | 說明 |
|---|---|
| 每科分鐘數 | 聽力／閱讀／寫作／口說各自填，**留空就用試卷預設（官方時間）** |
| 額外時間 % | 無障礙加時。填 25 就是每一科都多 25%，會疊加在上面的設定之上 |
| 快速設定 | 一鍵套用「官方標準」「+25% 加時」「+50% 加時」 |

例如聽力填 40、額外時間填 25，學生實際拿到的就是 50 分鐘。學生在科目清單上
會看到「50 分鐘（含加時 10 分）」，不會考到一半才發現時間不一樣。

> 時間的優先順序是：系統預設 → 試卷 JSON 的 `durationSec` → 指派時的每科覆寫 → 最後乘上加時百分比。

### ☕ 科目之間的休息

| 政策 | 行為 |
|---|---|
| **自由**（預設） | 學生回到科目清單，自己決定何時開始下一科 |
| **官方流程** | 聽力 → 閱讀 → 寫作 **連續進行**，一科結束後短暫過場就自動接下一科，不回科目清單 |
| **固定休息** | 每科之間休息 N 分鐘，畫面倒數，時間到自動進入下一科 |

雅思官方在聽力、閱讀、寫作之間是**不安排休息**的，所以選「官方流程」最貼近真實考場。
口說一律獨立進行，不受這個設定影響（官方也是分開考）。

### 🔒 監考／反作弊

預設**全部關閉**，要用再打開：

| 選項 | 做了什麼 |
|---|---|
| 強制全螢幕作答 | 開始考試時進入全螢幕；離開會跳出視窗要求回去，並記錄一次 |
| 禁止複製／貼上 | 擋掉從文章、題目複製文字，也擋掉把外部文字貼進作文（自己寫的內容仍可複製） |
| 切換分頁時警告 | 一離開考試畫面就跳警告，並告知已經第幾次 |
| 允許離開幾次 | 0 = 不設上限只記錄；設 3 就是第 3 次觸發處置 |
| 超過上限時 | **只警告**（建議）或 **自動結束該科** |

所有事件（離開畫面、回來、離開全螢幕、被擋下的複製貼上、自動收卷）都會寫進
`exam_events` 資料表，考完在成績頁的「**考試紀律**」分頁可以看到次數統計與完整時間軸。
學生只看得到自己的次數，看不到明細。

> **老實說**：這是瀏覽器端的防護，能擋掉「開另一個分頁查字典」「把事先寫好的作文貼進來」
> 這類隨手作弊，但**擋不了第二台裝置、手機或旁邊有人**。真正要嚴格監考仍然需要人在現場。
> 另外「自動結束該科」請謹慎使用——網路斷線或瀏覽器彈出視窗都可能誤觸。

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
- 可以再加一層 **Cloudflare Turnstile 人機驗證**，見下一節。

### 登入人機驗證（Cloudflare Turnstile）

預設關閉。要開的話：

1. 到 [Cloudflare 主控台 → Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) 免費新增一個 Widget，
   **Domain 填你的考試網址**（用 IP 直連時填 `localhost` 或關掉網域檢查）。
2. 拿到 Site Key 與 Secret Key，填進「系統設定 → 登入人機驗證」，勾選啟用。
   也可以寫在 `.env` 的 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` / `TURNSTILE_ENABLED=1`。
3. 按「測試 Secret Key」確認伺服器連得到 Cloudflare。
4. **用學生的電腦實際登入一次再正式宣布。**

幾個實作細節：

- Site Key 會出現在網頁原始碼（本來就是公開的）；**Secret Key 只存在伺服器**，
  後台與 API 回傳都只給遮罩後的字串。
- 驗證在比對帳密**之前**執行；驗證失敗時前端會自動重置元件（Turnstile 的 token 只能用一次）。
- 「連不到 Cloudflare 時仍允許登入」建議勾著。不勾的話，Cloudflare 一出狀況全校就都登不進來，
  而登入本來就還有速率限制在擋暴力破解。
- ⚠️ 這個選項救不了「**學生的瀏覽器**連不到 `challenges.cloudflare.com`」的情況 ——
  瀏覽器產不出驗證碼，伺服器再寬鬆也沒用。校內網路如果會擋這個網域，就不要開這個功能。
  遇到這種情形登入頁會直接把 Cloudflare 的錯誤代碼翻成中文說明（含目前網址），
  但**登入鈕不會被鎖住**，避免整個系統被自己的驗證機制擋在門外。
- 開發或測試可以用 Cloudflare 官方測試金鑰（後台有「填入測試金鑰」按鈕）：
  Site Key `1x00000000000000000000AA`、Secret Key `1x0000000000000000000000000000000AA`，一律通過。

#### 驗證框出不來 / 顯示「無法連線至網站」

登入頁會直接把 Cloudflare 的錯誤代碼翻成中文。常見的三個：

| 代碼 | 意思 | 怎麼修 |
|---|---|---|
| `110200` | **這個網域沒有被授權**（最常見） | Cloudflare → Turnstile → 該 Widget → Hostname Management，把你實際使用的網域加進去。填**主機名稱**就好，不要含 `https://`、不要含連接埠。用 IP 直連時 Turnstile 一律拒絕，必須改用網域。 |
| `110100` / `110110` / `400020` | Site Key 不對 | 檢查是不是把 Site Key 跟 Secret Key 貼反了。 |
| `200500` | 瀏覽器連不到 `challenges.cloudflare.com` | 校內防火牆、DNS 過濾或廣告封鎖擴充套件擋掉了。加白名單，或乾脆別開這個功能。 |

**被自己鎖在外面時**（驗證框壞掉，連管理員都進不了後台去關它）：

```bash
# 看目前設定
docker compose exec app node server/scripts/turnstile.js --status

# 關掉人機驗證（最多 15 秒後生效，不用重啟）
docker compose exec app node server/scripts/turnstile.js --off

# 修好之後再開回來
docker compose exec app node server/scripts/turnstile.js --on

# 直接從命令列換金鑰
docker compose exec app node server/scripts/turnstile.js \
  --site-key=0x4AAA... --secret-key=0x4AAA... --on

# 確認伺服器連得到 Cloudflare、Secret Key 有效
docker compose exec app node server/scripts/turnstile.js --test
```

手動安裝的話用 `npm run turnstile -- --off`。
另一條路是在 `.env` 加 `TURNSTILE_DISABLED=1` 再重啟 —— 這是硬性覆寫，
不管資料庫裡的開關是什麼都不會生效，適合放進緊急復原程序。
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
│   │   ├── jobs.js           AI 背景工作（整份試卷分段產生的進度與取消）
│   │   ├── realtime.js       口說即時語音 WebSocket 中繼與考官流程狀態機
│   │   ├── retention.js      資料保留政策與自動清理
│   │   └── tabular.js        Excel / CSV 匯入與範本產生
│   ├── routes/               auth, users, tests, importer, media, exam,
│   │                         speaking, results, ai, manage
│   └── scripts/              initDb.js, seed.js, resetPassword.js, turnstile.js
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
npm test                # 單元測試（33 項：批改、換算、驗證、匯入、錯誤處理）
npm start               # 另開一個終端機
node test/e2e.js        # 端對端測試（220 項）：登入 → 作答 → 交卷 → 批改 → 成績單
                        # → 老師改分 → 檔案管理 → 成績批次操作 → 保留政策與清理
                        # → 成員管理 → 題庫組卷 → 人機驗證 → AI 背景工作 → 素材保全
```

---

## 疑難排解

**`pull access denied for ielts-cbt, repository does not exist`**
Compose 跑去 Docker Hub 找映像檔了，但這個映像檔是在你自己機器上建的、不存在於任何 registry。
加上 `--build` 就會強制建置：

```bash
docker compose up -d --build
```

新版的 `docker-compose.yml` 已經寫了 `pull_policy: build`，`git pull` 之後就不會再遇到。

**帳號密碼明明是對的，卻登不進去**

管理員帳號**只在資料庫第一次初始化時建立一次**。如果你先啟動過一次、之後才改
`.env` 的 `ADMIN_PASSWORD`，資料庫裡存的仍然是舊密碼。用內建工具重設：

```bash
# 先看看有哪些帳號
docker compose exec app node server/scripts/resetPassword.js --list

# 重設密碼（帳號、新密碼）
docker compose exec app node server/scripts/resetPassword.js admin 新的密碼

# 手動安裝的話
npm run reset-password -- admin 新的密碼
```

這個工具也用來處理「學生忘記密碼」「老師帳號被停用」等狀況，重設時會一併把帳號設為啟用。

另外注意：同一個 IP 十分鐘內登入失敗 20 次會被暫時擋下（回 429），
一直試不進去時先等幾分鐘再說。

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

**`npm install` 卡在 xlsx 這個套件**
Excel 匯入用的 SheetJS 已經搬離 npm registry，改由官方 CDN 發布
（`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`，`package.json` 裡直接指向它）。
這麼做是因為 npm 上最後一版有 ReDoS 漏洞且不會再修。
若你的網路擋掉 cdn.sheetjs.com，請在防火牆放行；建置環境確實無法連外時，
可以先在能連網的機器下載 tgz，放進專案再改成本機路徑安裝。

**清理刪錯東西了怎麼辦？**
刪除無法復原。所以請養成習慣：先按「試算」確認清單，再執行；
重要的試卷與成績可以先用「試卷管理 → 完整備份」匯出一份 JSON 留底。

**交卷後一直顯示「批改中」**
表示 AI 批改失敗（通常是沒設定金鑰或額度用完）。聽力與閱讀的成績仍然正常。
到「系統設定」按「測試文字模型」找出原因，修好之後在成績頁按「重新批改」即可；
或改用老師人工評分。

**AI 出題的題目品質不穩**
把主題寫具體一點、指定難度，或先貼上自己的文章讓 AI 只依該文出題。

**學生考試時閱讀區顯示「（沒有文章內容）」、聽力沒有聲音**
表示那份試卷缺素材。到「試卷管理」看該列的「素材」按鈕有沒有 `⚠` 數字，
點下去逐節補上文章／音檔即可（只改素材，不會動到題目與答案）。

2.5.1 之前有一個 bug 會造成這個狀況：老師在「AI 出題」貼上自己的文章請 AI 依此出題時，
AI 只回傳題目、不會把原文再吐一次，而存檔時卻去讀 AI 回傳的 `passage`，
結果**老師貼的文章被靜靜丟掉**，學生端就只剩題目。已修正 ——
現在伺服器會把老師提供的原文一起帶回來，存檔時也會多一層防呆。
升級後既有的試卷不會自動修復，請用「素材」按鈕手動補一次。

**產生整份試卷時出現「This operation was aborted」**
舊版把整份試卷塞在一個 HTTP 請求裡等，三分鐘後被逾時掐斷，`abort` 是 Node 丟出的原始訊息。
現在改成分 9 段的背景工作了，升級後就不會再遇到：

```bash
git pull && docker compose up -d --build
```

如果升級後仍然是某一段逾時（畫面會明確指出是哪一段、等了幾秒），通常是模型太慢：
在 `.env` 調高 `AI_TIMEOUT_MS`（預設 180000 毫秒）再重啟，或換一個快一點的模型。
其餘段落產生成功的話，失敗畫面上的「取回已完成的部分」可以先把它們存成草稿試卷。

**按了「存進題庫」，卻找不到題庫在哪**
在導覽列的「**題庫**」（試卷和匯入題目中間）。存進去之後也可以直接按按鈕旁邊出現的
「前往題庫 →」。若導覽列沒看到，多半是瀏覽器讀到舊的快取檔，強制重新整理
（Ctrl / ⌘ + Shift + R）即可。

**登入頁的人機驗證框顯示「無法連線至網站」或一片空白**
先看驗證框裡的錯誤代碼——系統會把它翻成中文並附上目前網址。
最常見的是 `110200`（Cloudflare Widget 的網域清單沒有你的網域）與
`200500`（瀏覽器連不到 `challenges.cloudflare.com`）。
詳細對照表與「被鎖在外面」的救援指令見
[登入人機驗證](#登入人機驗證cloudflare-turnstile) 一節。急著進系統的話：

```bash
docker compose exec app node server/scripts/turnstile.js --off
```
AI 產生的題目一律建議人工校對後再指派給學生。

---

## 授權

MIT
