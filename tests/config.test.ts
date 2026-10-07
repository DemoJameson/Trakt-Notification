/**
 * 配置层：环境变量校验。
 *
 * 这里钉的是「两个 secret 必须分开」——`ADMIN_SECRET` 必填，且不能与
 * `CRON_SECRET` 相同。两者相同意味着 `CRON_SECRET`（按设计要贴进第三方调度
 * 后台的低信任凭据）就是管理员口令，所以 `loadConfig` 直接判为非法配置、
 * 拒绝启动，而不是只发一条告警。
 */
import { describe, expect, it } from 'vitest'

import { testKey } from './helpers/sqlite.ts'
import { loadConfig } from '../src/config.ts'

const baseEnv = {
  DB_DRIVER: 'libsql',
  DATABASE_URL: 'file::memory:',
  ENCRYPTION_KEY: testKey(),
  TRAKT_CLIENT_ID: 'the-client-id',
  CRON_SECRET: 'cron-secret-0123456789abcdef',
  ADMIN_SECRET: 'admin-secret-0123456789abcdef',
  SESSION_SECRET: 'session-secret-0123456789abcdef',
}

describe('配置：两个 secret 必须分开', () => {
  it('缺少 ADMIN_SECRET ⇒ 拒绝启动（不再回退到 CRON_SECRET）', () => {
    expect(() => loadConfig({ ...baseEnv, ADMIN_SECRET: '' })).toThrow(/ADMIN_SECRET/)
  })

  it('ADMIN_SECRET 与 CRON_SECRET 相同 ⇒ 拒绝启动', () => {
    expect(() => loadConfig({ ...baseEnv, ADMIN_SECRET: baseEnv.CRON_SECRET })).toThrow(/ADMIN_SECRET/)
  })

  it('两者不同 ⇒ 正常启动', () => {
    const cfg = loadConfig({ ...baseEnv })
    expect(cfg.adminSecret).toBe(baseEnv.ADMIN_SECRET)
    expect(cfg.cronSecret).toBe(baseEnv.CRON_SECRET)
  })
})
