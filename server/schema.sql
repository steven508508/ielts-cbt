-- ══════════════════════════════════════════════════════════════
--  IELTS CBT 模擬考試系統 — MySQL Schema
--  引擎 InnoDB / utf8mb4，相容 MySQL 5.7+ 與 MariaDB 10.4+
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL UNIQUE,
  password_hash VARCHAR(120) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(160) NULL,
  role          ENUM('admin','teacher','student') NOT NULL DEFAULT 'student',
  class_group   VARCHAR(80)  NULL,
  candidate_no  VARCHAR(40)  NULL,
  date_of_birth DATE         NULL,
  nationality   VARCHAR(80)  NULL,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_role (role),
  INDEX idx_users_class (class_group)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 試卷：content 欄位存放整份試卷的 JSON（modules → sections → groups → questions）
CREATE TABLE IF NOT EXISTS tests (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(200) NOT NULL,
  test_type   ENUM('academic','general') NOT NULL DEFAULT 'academic',
  description TEXT NULL,
  content     LONGTEXT NOT NULL,
  published   TINYINT(1) NOT NULL DEFAULT 0,
  created_by  INT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tests_pub (published),
  CONSTRAINT fk_tests_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 指派：可指派給單一學生或整個班級
CREATE TABLE IF NOT EXISTS assignments (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  test_id          INT UNSIGNED NOT NULL,
  user_id          INT UNSIGNED NULL,
  class_group      VARCHAR(80)  NULL,
  modules          VARCHAR(120) NOT NULL DEFAULT 'listening,reading,writing,speaking',
  speaking_grading ENUM('ai','human') NOT NULL DEFAULT 'ai',
  writing_grading  ENUM('ai','human') NOT NULL DEFAULT 'ai',
  open_from        DATETIME NULL,
  open_until       DATETIME NULL,
  max_attempts     INT UNSIGNED NOT NULL DEFAULT 1,
  created_by       INT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_asg_user (user_id),
  INDEX idx_asg_class (class_group),
  CONSTRAINT fk_asg_test FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_asg_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 考試場次
CREATE TABLE IF NOT EXISTS attempts (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  test_id        INT UNSIGNED NOT NULL,
  user_id        INT UNSIGNED NOT NULL,
  assignment_id  INT UNSIGNED NULL,
  status         ENUM('in_progress','submitted','grading','graded') NOT NULL DEFAULT 'in_progress',
  modules        VARCHAR(120) NOT NULL DEFAULT 'listening,reading,writing,speaking',
  current_module VARCHAR(20)  NULL,
  state          LONGTEXT     NULL,   -- 前端續考狀態（剩餘時間、目前題號…）
  listening_band DECIMAL(2,1) NULL,
  reading_band   DECIMAL(2,1) NULL,
  writing_band   DECIMAL(2,1) NULL,
  speaking_band  DECIMAL(2,1) NULL,
  overall_band   DECIMAL(2,1) NULL,
  started_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at   DATETIME NULL,
  graded_at      DATETIME NULL,
  INDEX idx_att_user (user_id),
  INDEX idx_att_test (test_id),
  INDEX idx_att_status (status),
  CONSTRAINT fk_att_test FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_att_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 逐題作答（聽力／閱讀）
CREATE TABLE IF NOT EXISTS answers (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attempt_id INT UNSIGNED NOT NULL,
  module     VARCHAR(20)  NOT NULL,
  q_number   INT          NOT NULL,
  response   TEXT         NULL,
  correct    TINYINT(1)   NULL,
  expected   TEXT         NULL,
  flagged    TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_answer (attempt_id, module, q_number),
  CONSTRAINT fk_ans_att FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 寫作作答
CREATE TABLE IF NOT EXISTS writing_responses (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attempt_id  INT UNSIGNED NOT NULL,
  task_no     TINYINT      NOT NULL,
  essay       LONGTEXT     NULL,
  word_count  INT          NOT NULL DEFAULT 0,
  band        DECIMAL(2,1) NULL,
  criteria    TEXT         NULL,  -- JSON: {TA:…, CC:…, LR:…, GRA:…}
  feedback    LONGTEXT     NULL,  -- JSON: 逐項評語與修改建議
  graded_by   VARCHAR(40)  NULL,  -- 'ai' 或老師 username
  graded_at   DATETIME     NULL,
  UNIQUE KEY uq_writing (attempt_id, task_no),
  CONSTRAINT fk_wr_att FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 口說作答（每題一列錄音）
CREATE TABLE IF NOT EXISTS speaking_responses (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attempt_id   INT UNSIGNED NOT NULL,
  part         TINYINT      NOT NULL,
  q_index      INT          NOT NULL DEFAULT 0,
  question     TEXT         NULL,
  audio_path   VARCHAR(255) NULL,
  transcript   LONGTEXT     NULL,
  duration_sec INT          NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_speaking (attempt_id, part, q_index),
  CONSTRAINT fk_sp_att FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 每一科的成績與評語
CREATE TABLE IF NOT EXISTS module_results (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attempt_id INT UNSIGNED NOT NULL,
  module     VARCHAR(20)  NOT NULL,
  raw_score  DECIMAL(5,1) NULL,
  total      INT          NULL,
  band       DECIMAL(2,1) NULL,
  criteria   TEXT         NULL,
  feedback   LONGTEXT     NULL,
  graded_by  VARCHAR(40)  NULL,
  graded_at  DATETIME     NULL,
  UNIQUE KEY uq_modres (attempt_id, module),
  CONSTRAINT fk_mr_att FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 媒體檔（聽力音檔、圖表、地圖）
CREATE TABLE IF NOT EXISTS media (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  filename      VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  kind          ENUM('audio','image','other') NOT NULL DEFAULT 'other',
  mime          VARCHAR(100) NULL,
  size          INT UNSIGNED NOT NULL DEFAULT 0,
  label         VARCHAR(200) NULL,
  uploaded_by   INT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_media_kind (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 獨立題組庫（AI 產題 / 匯入題目暫存，可再組成試卷）
CREATE TABLE IF NOT EXISTS question_bank (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  module     VARCHAR(20)  NOT NULL,
  type       VARCHAR(40)  NOT NULL,
  topic      VARCHAR(160) NULL,
  difficulty VARCHAR(20)  NULL,
  tags       VARCHAR(255) NULL,
  payload    LONGTEXT     NOT NULL,
  source     ENUM('manual','ai','import') NOT NULL DEFAULT 'manual',
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_qb_module (module),
  INDEX idx_qb_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 系統設定（AI 金鑰、端點…）
CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(80) PRIMARY KEY,
  v TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- AI 呼叫紀錄（除錯與用量追蹤）
CREATE TABLE IF NOT EXISTS ai_logs (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  purpose    VARCHAR(40) NOT NULL,
  provider   VARCHAR(40) NULL,
  model      VARCHAR(80) NULL,
  ok         TINYINT(1)  NOT NULL DEFAULT 1,
  ms         INT         NULL,
  error      TEXT        NULL,
  user_id    INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ailog_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── v2：即時口說評分 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS speaking_live (
  attempt_id INT UNSIGNED PRIMARY KEY,
  part       TINYINT      NULL,
  turns      INT          NOT NULL DEFAULT 0,
  criteria   TEXT         NULL,
  band       DECIMAL(2,1) NULL,
  notes      TEXT         NULL,
  transcript LONGTEXT     NULL,
  status     VARCHAR(20)  NOT NULL DEFAULT 'idle',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_splive_att FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── v2：資料維護紀錄 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_log (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  action     VARCHAR(60)  NOT NULL,
  detail     TEXT         NULL,
  affected   INT          NOT NULL DEFAULT 0,
  freed_bytes BIGINT      NOT NULL DEFAULT 0,
  actor      VARCHAR(80)  NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_maint_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
