-- HANT_INMU_PLAY  D1 スキーマ
-- 個人情報になり得る列（メール・IP・端末情報・作成日時の秒単位など）は意図的に持たない。
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,           -- 公開してよいランダムID（10文字）
  name          TEXT NOT NULL,              -- ランキングに出る表示名
  name_key      TEXT NOT NULL UNIQUE,       -- 重複判定用（NFKC+小文字）
  pw_salt       TEXT NOT NULL,
  pw_hash       TEXT NOT NULL,              -- HMAC(PEPPER, "pw|salt|<ブラウザでPBKDF2済みの値>")
  score         INTEGER NOT NULL DEFAULT 0,
  score_ts      INTEGER NOT NULL,           -- 点数の最終更新(秒)。加点速度チェック用
  last_access   INTEGER NOT NULL,           -- 最終アクセス(分に丸めたUNIX秒)
  created_h     INTEGER NOT NULL,           -- 登録した「時間帯」(UNIX時/3600)。登録スパム抑制用
  fail_pw       INTEGER NOT NULL DEFAULT 0,
  lock_pw_until INTEGER NOT NULL DEFAULT 0,
  bonus_ts      INTEGER NOT NULL DEFAULT 0  -- 完走ボーナスを最後に受け取った時刻(秒)。連続取得の抑止用
);
CREATE INDEX IF NOT EXISTS idx_accounts_score  ON accounts (score DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts (last_access);
CREATE INDEX IF NOT EXISTS idx_accounts_hour   ON accounts (created_h);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,              -- トークンのSHA-256のみ保存（生トークンは持たない）
  account_id TEXT NOT NULL,
  expires    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);
