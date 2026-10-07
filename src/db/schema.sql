-- ===================================================================
-- Trakt 播出提醒 —— 通用 DDL
--
-- 目标方言：SQLite（libSQL / Cloudflare D1）。
--
-- ⚠️ 这是**唯一的结构来源**，没有任何"升级已有结构"的机制：
--   结构变了就是变了，需要重建库（自托管：删掉 .db 重跑 db:init；
--   D1：重新执行 db:sql）。否则每个写路径都要为"可能不存在"的列留分支，
--   而那些分支永远不会触发 —— 却让后来的人以为它有作用。
-- ===================================================================

-- ---------------------------------------------------------------
-- 用户
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  -- ⚠️ 身份**只认 trakt_slug**（Trakt 的 user 对象现在只有 slug，没有数字 id）。
  --    trakt_username 只是展示名与删号时的确认串，不参与查找。
  trakt_username  TEXT NOT NULL,
  trakt_slug      TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',   -- IANA 名称
  locale          TEXT NOT NULL DEFAULT 'zh-CN',
  -- 管理员**不在这一行上**：他是持有 ADMIN_SECRET 的独立身份（走 tn_admin 会话），
  -- 不绑任何 Trakt 账号 —— 停用某个用户不该连带停掉管理权。
  status          TEXT NOT NULL DEFAULT 'active',          -- active | suspended
  created_at      INTEGER NOT NULL,                        -- epoch ms
  last_login_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_trakt_slug ON users(trakt_slug);

-- ---------------------------------------------------------------
-- Trakt 凭据（加密存储）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trakt_tokens (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token_enc    TEXT NOT NULL,     -- AES-GCM
  refresh_token_enc   TEXT NOT NULL,     -- AES-GCM；单次使用，必须原子替换
  -- refresh_token 明文的 SHA-256。
  -- 用途：并发刷新时做 CAS（compare-and-swap）—— 只有"我读到的那把 token 还没被换掉"
  -- 才允许写入。存哈希而不是明文，是为了让这次比较不需要解密整行。
  --   UPDATE ... WHERE user_id=? AND refresh_token_hash=?
  --   changes=1 表示我赢了；changes=0 表示别人先刷成功了，我要用他的结果
  refresh_token_hash  TEXT NOT NULL,
  token_expires_at    INTEGER NOT NULL,  -- epoch ms，来自 expires_in，不要硬编码 7 天
  refreshed_at        INTEGER,
  last_refresh_error  TEXT,
  reauth_required     INTEGER NOT NULL DEFAULT 0,
  reauth_reason       TEXT
);

-- ---------------------------------------------------------------
-- 规则
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rules (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,

  -- 「通知哪些内容」—— 单一结构，剧集一组 + 电影一组。
  -- 对应界面上那一个「通知哪些内容」区块，没有第二个轴。
  --
  -- {
  --   "episodes": { "all": true,  "seasonPremiere": false, "seasonFinale": false,
  --                 "seriesPremiere": false, "seriesFinale": false },
  --   "movies":   { "all": false, "theatrical": true, "homeRelease": false }
  -- }
  --
  -- 不变式（写入前由 normalizeContentSelection 强制）：
  --   all 为真时，同组其余项必须全为 false
  --   seasonPremiere 与 seriesPremiere 不得同时为真（本季 ⊃ 全剧）
  --   seasonFinale   与 seriesFinale   不得同时为真（本季 ⊃ 全剧）
  --
  -- 需要拉哪些 Trakt 端点由这个勾选结果推导（见 src/core/selection.ts
  -- requiredEndpoints），用户不需要知道端点的存在。
  content          TEXT NOT NULL,

  -- 通知时刻恒以 Trakt 的 first_aired 为基准，再叠加偏移。没有第二种语义：
  -- 整条时间轴都按 first_aired 算，不提供其它锚点。
  offset_minutes   INTEGER NOT NULL DEFAULT 0,          -- 负=提前，正=延后

  mode             TEXT NOT NULL DEFAULT 'digest',      -- realtime | digest
  digest_time      TEXT DEFAULT '08:00',

  skip_watched     INTEGER NOT NULL DEFAULT 1,
  quiet_hours      TEXT,                                -- '23:00-08:00'

  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_user ON rules(user_id, enabled);

-- ---------------------------------------------------------------
-- 实例级设置（管理员可调的开关）
--
-- 只放开关，不放业务数据 —— 业务数据都在各自的表里按 user_id 隔离。
--
-- 为什么不用 cache 表：cache 有 expires_at，「过期即失效」是它的核心语义，
-- 而实例开关是"永久有效直到被改"。语义不同的东西塞进同一张表，
-- 迟早有人手滑清了缓存把配置一起清掉。
--
-- key-value 而不是一行多列：加一个开关只登记一个默认值即可。
-- ⚠️ 注册口令的**哈希**单独一行（registration_secret_hash），
--    刻意不并进下面的结构 —— 它绝不能跟着 settings 出现在任何响应里。
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------
-- 推送渠道
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,          -- bark | telegram | ntfy | webhook | ...
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  config_enc    TEXT NOT NULL,          -- AES-GCM(JSON)
  priority      INTEGER NOT NULL DEFAULT 0,
  fail_streak   INTEGER NOT NULL DEFAULT 0,
  disabled_at   INTEGER,                -- 连续失败 20 次自动停用
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id, enabled);

-- ---------------------------------------------------------------
-- 投递记录 —— 幂等基石
--
-- 唯一索引让重复 tick / 重叠执行 / 失败重试都变成
-- INSERT ... ON CONFLICT DO NOTHING 的无害操作。
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id         TEXT NOT NULL,
  channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

  item_key        TEXT NOT NULL,        -- 'episodic:1234:S02E07' | 'movie:5678'
  notify_at       INTEGER NOT NULL,     -- 计划发送时刻（UTC，epoch ms，含静默顺延）
  scheduled_for   INTEGER,              -- digest 模式下实际的汇总发送时刻

  title           TEXT NOT NULL,
  body            TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed | skipped
  attempts        INTEGER NOT NULL DEFAULT 0,
  http_status     INTEGER,
  last_error      TEXT,
  sent_at         INTEGER,
  next_retry_at   INTEGER,
  created_at      INTEGER NOT NULL
);

-- ★ 防重复推送的核心约束
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_idem
  ON deliveries(rule_id, channel_id, item_key, notify_at);

-- 调度主查询：待发送 & 待重试
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_user    ON deliveries(user_id, created_at DESC);
-- 投递日志按状态筛选并分页：user_id + status + created_at
-- 少了 status 只能拿到前两个条件后在行上逐条过滤 —— 一个用户攒下几万条
-- 投递之后会变明显。
CREATE INDEX IF NOT EXISTS idx_deliveries_user_status
  ON deliveries(user_id, status, created_at DESC);

-- ---------------------------------------------------------------
-- 计划表 —— 「该发什么、何时发」的持久化计划
--
-- 为什么要它：之前每分钟的 tick 都要重新拉一遍 Trakt 日历再算一遍计划，
-- 代价是「用户数 × 端点数」请求/分钟。拆成两段后：重算计划按
-- PLAN_REFRESH_MINUTES 限频，派发只查本表 notify_at <= now 的待发项、不碰 Trakt。
--
-- 唯一键 (rule_id, item_key, notify_at)：重算时命中冲突只刷新 payload 与
-- refreshed_at，**绝不改 status** —— 已发过的（done）不能被重算复活。
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id      TEXT NOT NULL,
  item_key     TEXT NOT NULL,        -- 'episodic:123:S02E07' | 'movie:5678' | 'digest:<groupKey>'
  notify_at    INTEGER NOT NULL,     -- 计划发送时刻（UTC，epoch ms，含静默顺延）
  payload      TEXT NOT NULL,        -- 渲染好的消息 + 图片/链接加工上下文（JSON）
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | done
  refreshed_at INTEGER NOT NULL,     -- 本轮重算的戳；据此删除已失效的待发项
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON notification_jobs(rule_id, item_key, notify_at);
-- 派发主查询：pending 且已到期
CREATE INDEX IF NOT EXISTS idx_jobs_due ON notification_jobs(status, notify_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON notification_jobs(user_id, status, notify_at);

-- ---------------------------------------------------------------
-- 剧集元数据缓存（finale 判定的输入）
--
-- Trakt API 没有 finales 端点，"只推完结集"必须靠 season.episode_count
-- 与 show.status 推导。这部分数据变化很慢，缓存 7 天可把每 tick 的
-- Trakt 调用从 O(剧集数) 降到 O(1)。
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS show_meta (
  trakt_id             INTEGER PRIMARY KEY,
  title                TEXT,
  status               TEXT,        -- returning series | ended | canceled
  season_count         INTEGER,
  last_season_number   INTEGER,
  last_season_ep_count INTEGER,
  seasons_json         TEXT,        -- [{ number, episode_count, aired_episodes }]
  last_finale_level    TEXT,        -- 上次判定的完结等级，用于漂移检测
  fetched_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_show_meta_fetched ON show_meta(fetched_at);

-- ---------------------------------------------------------------
-- 通用缓存
--
-- 目前两个用途：
--   1. 已看剧集集合（watched:<userId>）—— /sync/watched/shows 的响应很大，
--      一个 tick 拉一次是浪费，缓存几小时能把调用量从 288 次/天降到个位数
--   2. 调度心跳（tick:last）—— 「上次 tick 时间」用于健康检查，
--      专治"外部调度一天只跑一次，用户以为坏了"
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

-- ---------------------------------------------------------------
-- 分布式锁
--   全局 tick 锁（防重叠执行）
--   单用户 token 刷新锁（防并发刷新把 refresh_token 互相作废）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locks (
  key         TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at);
