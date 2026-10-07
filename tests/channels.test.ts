/**
 * 渠道单元测试 —— 重点是三类"看起来正常但其实全错"的问题：
 *
 *   1. **签名算法的参数角色**。飞书把 `timestamp+"\n"+secret` 当 HMAC 的 key，
 *      钉钉把 `secret` 当 key。两者写反了照样能算出 base64，只是永远校验不过，
 *      而平台只会回一句 "sign match fail"，完全不提示哪里错了。
 *   2. **HTTP 200 也可能是失败**。国内平台全都有这个特性，只判断 `res.ok`
 *      会让配错的渠道永远显示"已发送" —— 而且投递记录是成功的，连重试都不触发。
 *   3. **按字节截断**。企业微信按字节限额，`String.slice` 会把中文切碎
 *      变成替换字符，平台报 `invalid utf-8`，看不出是长度问题。
 *
 *   node --experimental-strip-types 由 vitest 处理
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { feishuSign, dingtalkSign, toBase64 } from '../src/channels/sign.ts'
import { withDefaults } from '../src/channels/registry.ts'
import { maskSecret } from '../src/crypto.ts'
import {
  assertAllowedHost,
  byteLength,
  parsePlatformResponse,
  truncateBytes,
  describeFetchError,
} from '../src/channels/types.ts'
import { feishuChannel } from '../src/channels/feishu.ts'
import { dingtalkChannel } from '../src/channels/dingtalk.ts'
import { wecomChannel } from '../src/channels/wecom.ts'
import { serverChanChannel } from '../src/channels/serverchan.ts'
import { pushPlusChannel } from '../src/channels/pushplus.ts'
import { discordChannel } from '../src/channels/discord.ts'
import { slackChannel } from '../src/channels/slack.ts'
import { getChannel, supportedTypes } from '../src/channels/registry.ts'
import { barkChannel } from '../src/channels/bark.ts'
import { ntfyChannel } from '../src/channels/ntfy.ts'
import { installMockFetch, type MockFetch } from './helpers/trakt-mock.ts'

const MSG = {
  title: '【本季完结】熊家餐馆 S04E08',
  body: 'Forever\n播出：2026年10月4日 10:00\n提前 30 分钟',
  url: 'https://trakt.tv/shows/the-bear/seasons/4/episodes/8',
  priority: 'high' as const,
}

/* ================================================================== */
/* 签名                                                                */
/* ================================================================== */

describe('飞书 / 钉钉签名', () => {
  /*
   * 这一组是本次实现里最该守住的断言。
   *
   * 两家都用 HMAC-SHA256 + base64，字符串拼接也一模一样（`ts\nsecret`），
   * 唯一的区别是**谁当 key、谁当 data**：飞书反过来，钉钉正着来。
   * 把其中一个抄成另一个，代码照样跑、签名照样是一串合法 base64，
   * 只是平台永远返回校验失败 —— 极难排查。
   */

  it('同样的输入下两者结果不同（参数角色相反）', async () => {
    const secret = 'my-shared-secret'
    const feishu = await feishuSign(secret, 1599360473)
    // 钉钉要毫秒，为了对比同一份字符串这里先造出未 urlEncode 的等价形式
    const dingtalk = await dingtalkSign(secret, 1599360473)

    expect(feishu).not.toBe(dingtalk)
  })

  it('钉钉的签名是 urlEncode 过的，飞书不是', async () => {
    const secret = 'my-shared-secret'
    const feishu = await feishuSign(secret, 1599360473)
    const dingtalk = await dingtalkSign(secret, 1599360473)

    // 标准 base64 的字母表含 + / =
    expect(feishu).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    // urlEncode 之后不应再出现裸的 + / =
    expect(dingtalk).not.toContain('+')
    expect(dingtalk).not.toContain('/')
    expect(dingtalk).not.toContain('=')
    // 反过来解码后应当能还原成合法的 base64
    expect(decodeURIComponent(dingtalk)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })

  it('签名是确定性的（同输入同输出）', async () => {
    expect(await feishuSign('s', 1000)).toBe(await feishuSign('s', 1000))
    expect(await dingtalkSign('s', 1000)).toBe(await dingtalkSign('s', 1000))
  })

  it('时间戳或密钥变了，签名就变', async () => {
    const a = await feishuSign('s', 1000)
    expect(await feishuSign('s', 1001)).not.toBe(a)
    expect(await feishuSign('t', 1000)).not.toBe(a)
  })

  it('飞书签名 = base64(HMAC(key="ts\\nsecret", data=""))', async () => {
    // 用文档里的参考实现独立算一遍，确认我们没把 key/data 写反
    const secret = 'demo'
    const ts = 1599360473
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(`${ts}\n${secret}`),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const expected = toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(0))))

    expect(await feishuSign(secret, ts)).toBe(expected)
  })

  it('钉钉签名 = urlEncode(base64(HMAC(key=secret, data="ts\\nsecret")))', async () => {
    const secret = 'SEC0123456789'
    const ts = 1700000000000
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const data = new TextEncoder().encode(`${ts}\n${secret}`)
    const expected = encodeURIComponent(toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, data))))

    expect(await dingtalkSign(secret, ts)).toBe(expected)
  })
})

/* ================================================================== */
/* 字节截断                                                            */
/* ================================================================== */

describe('按字节截断（企业微信限额）', () => {
  it('byteLength 按 UTF-8 计数，中文 3 字节', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('中')).toBe(3)
    expect(byteLength('中文')).toBe(6)
    expect(byteLength('😀')).toBe(4) // emoji 是 4 字节，且是代理对
  })

  it('未超限时原样返回', () => {
    expect(truncateBytes('短', 100)).toBe('短')
  })

  it('超限时结果不超过上限', () => {
    const long = '中'.repeat(2000) // 6000 字节
    const out = truncateBytes(long, 4096)
    expect(byteLength(out)).toBeLessThanOrEqual(4096)
    expect(out.endsWith('…')).toBe(true)
  })

  it('不切碎多字节字符（切完仍是合法 UTF-8）', () => {
    // 直接用 slice 会在码元中间断开，产生 U+FFFD
    for (const limit of [10, 11, 12, 13, 100, 101, 4095]) {
      const out = truncateBytes('中'.repeat(200), limit)
      expect(out).not.toContain('\uFFFD')
      expect(byteLength(out)).toBeLessThanOrEqual(limit)
    }
  })

  it('emoji 也不会被切成半个代理对', () => {
    const out = truncateBytes('😀'.repeat(100), 33)
    expect(out).not.toContain('\uFFFD')
    // 每个 emoji 4 字节，(33-3)/4 = 7 个
    expect(byteLength(out)).toBeLessThanOrEqual(33)
  })
})

/* ================================================================== */
/* 域名白名单                                                          */
/* ================================================================== */

describe('官方域名白名单', () => {
  const hosts = ['dingtalk.com'] as const

  it('接受官方域名和子域', () => {
    expect(() => assertAllowedHost(new URL('https://oapi.dingtalk.com/robot/send'), hosts)).not.toThrow()
    expect(() => assertAllowedHost(new URL('https://dingtalk.com/x'), hosts)).not.toThrow()
  })

  it('拒绝"后缀像但不是子域"的伪装域名', () => {
    // 这是最容易写错的一处：如果用 endsWith 直接比字符串，
    // "oapi.dingtalk.com.attacker.net" 就会通过
    expect(() => assertAllowedHost(new URL('https://oapi.dingtalk.com.attacker.net/x'), hosts)).toThrow()
    expect(() => assertAllowedHost(new URL('https://evil-dingtalk.com/x'), hosts)).toThrow()
    expect(() => assertAllowedHost(new URL('https://dingtalk.com.evil.io/x'), hosts)).toThrow()
  })

  it('拒绝完全无关的域名', () => {
    expect(() => assertAllowedHost(new URL('https://example.com/x'), hosts)).toThrow()
  })
})

/* ================================================================== */
/* 响应解析：HTTP 200 也可能是失败                                      */
/* ================================================================== */

describe('平台响应解析', () => {
  const res = (body: unknown, status = 200) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  it('code=0 → 成功（飞书 / 钉钉 / 企微 / Server酱）', async () => {
    expect((await parsePlatformResponse(res({ code: 0, msg: 'success' }))).ok).toBe(true)
    expect((await parsePlatformResponse(res({ errcode: 0, errmsg: 'ok' }))).ok).toBe(true)
  })

  it('HTTP 200 + code≠0 → **失败**（这是各平台最大的坑）', async () => {
    const r = await parsePlatformResponse(res({ code: 19021, msg: 'sign match fail' }), () => '检查签名密钥')
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(200)
    expect(r.code).toBe(19021)
    expect(r.detail).toContain('签名')
  })

  it('HTTP 200 + errcode=310000 → 失败', async () => {
    const r = await parsePlatformResponse(
      res({ errcode: 310000, errmsg: 'keywords not in content' }),
      () => '关键词不匹配',
    )
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('关键词')
  })

  it('PushPlus 的成功码是 200 而不是 0', async () => {
    // 实测：token 无效时返回 HTTP 200 + {"code":903,...}
    expect((await parsePlatformResponse(res({ code: 200, msg: '请求成功' }), undefined, [200])).ok).toBe(true)
    expect((await parsePlatformResponse(res({ code: 903, msg: '用户令牌不正确' }), undefined, [200])).ok).toBe(false)
    // 用默认成功码 [0] 去解 PushPlus 的成功响应，必须判为失败 —— 防止忘了传参数
    expect((await parsePlatformResponse(res({ code: 200, msg: '请求成功' }))).ok).toBe(false)
  })

  it('非 2xx → 失败，即使 body 里的 code 是 0', async () => {
    const r = await parsePlatformResponse(res({ code: 40001, message: '[AUTH]错误的Key' }, 400))
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(400)
  })

  it('body 不是 JSON 时退回看 HTTP 状态码', async () => {
    expect((await parsePlatformResponse(res('<html>ok</html>', 200))).ok).toBe(true)
    expect((await parsePlatformResponse(res('<html>oops</html>', 502))).ok).toBe(false)
  })

  it('explain 认不出错误码时不编造建议', async () => {
    const r = await parsePlatformResponse(res({ code: 12345, msg: 'something' }), () => undefined)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('code=12345')
    expect(r.detail).not.toContain('→')
  })
})

/* ================================================================== */
/* 各渠道的 send()                                                     */
/* ================================================================== */

describe('飞书渠道', () => {
  let mock: MockFetch
  afterEach(() => mock?.restore())

  it('未开签名时 body 里没有 timestamp / sign', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'open.feishu.cn', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ code: 0, msg: 'success' })) } },
    ])
    const r = await feishuChannel.send(MSG, { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', msgType: 'post' })
    expect(r.ok).toBe(true)
    expect(sent.msg_type).toBe('post')
    expect(sent).not.toHaveProperty('sign')
    expect(sent).not.toHaveProperty('timestamp')
  })

  it('开启签名时 timestamp 与 sign 放在 body 顶层，且 timestamp 是**秒**', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'open.feishu.cn', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ code: 0 })) } },
    ])
    const r = await feishuChannel.send(MSG, {
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x',
      secret: 's3cret',
      msgType: 'text',
    })
    expect(r.ok).toBe(true)
    expect(typeof sent.timestamp).toBe('string') // 飞书要求字符串
    const ts = Number(sent.timestamp)
    // 秒级：和当前秒数相差不到 5 秒（写成毫秒的话这里会差三个数量级）
    expect(Math.abs(ts - Math.floor(Date.now() / 1000))).toBeLessThan(5)
    expect(sent.sign).toBe(await feishuSign('s3cret', ts))
  })

  it('富文本是「段落数组」，每段又是节点数组（写错会被平台判格式错误）', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'open.feishu.cn', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ code: 0 })) } },
    ])
    await feishuChannel.send(MSG, { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', msgType: 'post' })

    const content = (sent.content as { post: { zh_cn: { title: string; content: unknown[][] } } }).post.zh_cn
    expect(content.title).toContain('熊家餐馆')
    expect(Array.isArray(content.content)).toBe(true)
    // 两个段落：正文 + 链接
    expect(content.content).toHaveLength(2)
    for (const paragraph of content.content) {
      expect(Array.isArray(paragraph)).toBe(true)
      expect(paragraph.length).toBeGreaterThan(0)
    }
    expect(content.content[1]![0]).toMatchObject({ tag: 'a', href: MSG.url })
  })

  it('卡片模式把结构放在 card 字段（不是 content）', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'open.feishu.cn', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ code: 0 })) } },
    ])
    await feishuChannel.send(MSG, { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', msgType: 'interactive', cardColor: 'red' })

    expect(sent.msg_type).toBe('interactive')
    expect(sent).toHaveProperty('card')
    expect(sent).not.toHaveProperty('content')
    const card = sent.card as { schema: string; header: { template: string } }
    expect(card.schema).toBe('2.0')
    expect(card.header.template).toBe('red')
  })

  it('HTTP 200 但 code=19021 → 判失败，并给出签名相关的提示', async () => {
    mock = installMockFetch([
      { match: 'open.feishu.cn', reply: { code: 19021, msg: 'sign match fail or timestamp is not within one hour' } },
    ])
    const r = await feishuChannel.send(MSG, { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(200)
    expect(r.detail).toContain('签名')
  })

  it('非官方域名直接拒绝，不发请求', async () => {
    mock = installMockFetch([{ match: 'http', reply: { code: 0 } }])
    const r = await feishuChannel.send(MSG, { webhookUrl: 'https://evil.example.com/hook/x' })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('官方地址')
    expect(mock.log).toHaveLength(0)
  })

  it('国际版域名 larksuite.com 也是允许的', async () => {
    mock = installMockFetch([{ match: 'larksuite.com', reply: { code: 0 } }])
    const r = await feishuChannel.send(MSG, { webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/x' })
    expect(r.ok).toBe(true)
  })
})

describe('钉钉渠道', () => {
  let mock: MockFetch
  afterEach(() => mock?.restore())

  it('未加签时不带 timestamp / sign', async () => {
    mock = installMockFetch([{ match: 'oapi.dingtalk.com', reply: { errcode: 0, errmsg: 'ok' } }])
    await dingtalkChannel.send(MSG, { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc', msgType: 'markdown' })
    expect(mock.log[0]!.url).not.toContain('sign=')
    expect(mock.log[0]!.url).toContain('access_token=abc')
  })

  it('加签时 timestamp(毫秒) 与 sign 进 **query string**，不是 body', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'oapi.dingtalk.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ errcode: 0 })) } },
    ])
    const r = await dingtalkChannel.send(MSG, {
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
      secret: 'SEC123',
    })
    expect(r.ok).toBe(true)

    const url = new URL(mock.log[0]!.url)
    const ts = Number(url.searchParams.get('timestamp'))
    // 毫秒级：和当前毫秒数相差不到 5 秒
    expect(Math.abs(ts - Date.now())).toBeLessThan(5000)
    expect(url.searchParams.get('sign')).toBe(await dingtalkSign('SEC123', ts))
    // 关键：不在 body 里
    expect(sent).not.toHaveProperty('timestamp')
    expect(sent).not.toHaveProperty('sign')
    // 原有的 access_token 不能被覆盖掉
    expect(url.searchParams.get('access_token')).toBe('abc')
  })

  it('markdown 的 title 必须存在（它显示在通知栏）', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'oapi.dingtalk.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ errcode: 0 })) } },
    ])
    await dingtalkChannel.send(MSG, { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=a', msgType: 'markdown' })
    const md = sent.markdown as { title: string; text: string }
    expect(md.title).toBeTruthy()
    expect(md.title).toContain('熊家餐馆')
    expect(md.text).toContain(MSG.url)
  })

  it('errcode=310000 会按 errmsg 区分三种安全设置问题', async () => {
    const cases: Array<[string, string]> = [
      ['keywords not in content', '关键词'],
      ['sign not match', '签名'],
      ['ip XXX not in whitelist', 'IP'],
    ]
    for (const [errmsg, expectWord] of cases) {
      mock?.restore()
      mock = installMockFetch([{ match: 'oapi.dingtalk.com', reply: { errcode: 310000, errmsg } }])
      const r = await dingtalkChannel.send(MSG, { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=a' })
      expect(r.ok).toBe(false)
      expect(r.detail, errmsg).toContain(expectWord)
    }
  })

  /*
   * 这两条错误码是**向真实接口发假 token 实测**得到的，不是猜的：
   *   钉钉 → HTTP 200 + {"errcode":300005,"errmsg":"token is not exist"}
   *   企微 → HTTP 200 + {"errcode":93000,"errmsg":"invalid webhook url, hint: ..."}
   * 最初我按社区流传的 300001 写映射，实测发现实际是 300005 —— 于是两个都收。
   */
  it('实测的 errcode=300005（token 不存在）也要能翻译', async () => {
    mock = installMockFetch([
      { match: 'oapi.dingtalk.com', reply: { errcode: 300005, errmsg: 'token is not exist' } },
    ])
    const r = await dingtalkChannel.send(MSG, { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=a' })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(200)
    expect(r.detail).toContain('access_token 无效')
  })

  it('社区流传的 errcode=300001 同样能翻译（两个码都留着）', async () => {
    mock = installMockFetch([
      { match: 'oapi.dingtalk.com', reply: { errcode: 300001, errmsg: 'token is not exist' } },
    ])
    const r = await dingtalkChannel.send(MSG, { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=a' })
    expect(r.detail).toContain('access_token 无效')
  })

  it('@ 手机号与 @所有人 会进 at 字段', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'oapi.dingtalk.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ errcode: 0 })) } },
    ])
    await dingtalkChannel.send(MSG, {
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=a',
      msgType: 'text',
      atMobiles: '13800000000, 13900000000',
      atAll: true,
    })
    expect(sent.at).toEqual({ atMobiles: ['13800000000', '13900000000'], isAtAll: true })
  })
})

describe('企业微信渠道', () => {
  let mock: MockFetch
  afterEach(() => mock?.restore())

  it('markdown 模式内容不超过 4096 字节', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'qyapi.weixin.qq.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ errcode: 0 })) } },
    ])
    await wecomChannel.send(
      { ...MSG, body: '中'.repeat(3000) }, // 9000 字节
      { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', msgType: 'markdown' },
    )
    const content = (sent.markdown as { content: string }).content
    expect(byteLength(content)).toBeLessThanOrEqual(4096)
    expect(content).not.toContain('\uFFFD')
  })

  it('text 模式的限额更紧（2048 字节）', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'qyapi.weixin.qq.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ errcode: 0 })) } },
    ])
    await wecomChannel.send(
      { ...MSG, body: '中'.repeat(2000) },
      { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', msgType: 'text' },
    )
    expect(byteLength((sent.text as { content: string }).content)).toBeLessThanOrEqual(2048)
  })

  it('text 模式的 @ 用 mentioned_list / mentioned_mobile_list 字段', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'qyapi.weixin.qq.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ errcode: 0 })) } },
    ])
    await wecomChannel.send(MSG, {
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
      msgType: 'text',
      mentionedMobiles: '13800000000',
      atAll: true,
    })
    expect(sent.text).toMatchObject({
      mentioned_mobile_list: ['13800000000'],
      mentioned_list: ['@all'],
    })
  })

  it('markdown_v2 走独立的字段名', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'qyapi.weixin.qq.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ errcode: 0 })) } },
    ])
    await wecomChannel.send(MSG, {
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
      msgType: 'markdown_v2',
    })
    expect(sent.msgtype).toBe('markdown_v2')
    expect(sent).toHaveProperty('markdown_v2')
    expect(sent).not.toHaveProperty('markdown')
  })

  it('errcode=45009 提示频率超限并建议改用汇总', async () => {
    mock = installMockFetch([
      { match: 'qyapi.weixin.qq.com', reply: { errcode: 45009, errmsg: 'api freq out of limit' } },
    ])
    const r = await wecomChannel.send(MSG, { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('20 条')
    expect(r.detail).toContain('汇总')
  })

  it('实测的 errcode=93000（webhook 地址无效）也要能翻译', async () => {
    mock = installMockFetch([
      {
        match: 'qyapi.weixin.qq.com',
        reply: { errcode: 93000, errmsg: 'invalid webhook url, hint: [1790838180189711573764431], from ip: 1.2.3.4' },
      },
    ])
    const r = await wecomChannel.send(MSG, { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(200)
    expect(r.detail).toContain('webhook 地址无效')
  })
})

describe('Server 酱 / PushPlus', () => {
  let mock: MockFetch
  afterEach(() => mock?.restore())

  it('Server 酱用表单编码提交 title / desp', async () => {
    let raw = ''
    let ctype = ''
    mock = installMockFetch([
      { match: 'sctapi.ftqq.com', reply: (_u, init) => {
        raw = String(init?.body)
        ctype = String((init?.headers as Record<string, string>)['Content-Type'])
        return new Response(JSON.stringify({ code: 0, message: '', data: {} }))
      } },
    ])
    const r = await serverChanChannel.send(MSG, { webhookUrl: 'https://sctapi.ftqq.com/SCTabc.send', channelTag: 'Trakt' })
    expect(r.ok).toBe(true)
    expect(ctype).toContain('x-www-form-urlencoded')
    const params = new URLSearchParams(raw)
    expect(params.get('title')).toBe('[Trakt] ' + MSG.title)
    expect(params.get('desp')).toContain(MSG.url)
    // 中文不能丢
    expect(params.get('title')).toContain('熊家餐馆')
  })

  it('Server 酱失败时走非 2xx + code=40001，仍然判失败', async () => {
    mock = installMockFetch([
      { match: 'sctapi.ftqq.com', reply: { code: 40001, message: '[AUTH]错误的Key' }, status: 400 },
    ])
    const r = await serverChanChannel.send(MSG, { webhookUrl: 'https://sctapi.ftqq.com/BAD.send' })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('SendKey')
  })

  it('Server 酱新版 *.push.ft07.com 域名也允许', async () => {
    mock = installMockFetch([{ match: 'push.ft07.com', reply: { code: 0 } }])
    const r = await serverChanChannel.send(MSG, { webhookUrl: 'https://12345.push.ft07.com/send/SCTabc.send' })
    expect(r.ok).toBe(true)
  })

  it('PushPlus 把成功码 200 传给了解析器（否则永远判失败）', async () => {
    mock = installMockFetch([{ match: 'pushplus.plus', reply: { code: 200, msg: '请求成功', data: 'x' } }])
    const r = await pushPlusChannel.send(MSG, { token: 'tk' })
    expect(r.ok).toBe(true)
  })

  it('PushPlus 实测到的 903（token 无效）能被翻译成人话', async () => {
    mock = installMockFetch([
      { match: 'pushplus.plus', reply: { code: 903, data: '无效的用户token', msg: '用户令牌不正确' } },
    ])
    const r = await pushPlusChannel.send(MSG, { token: 'bad' })
    expect(r.ok).toBe(false)
    // HTTP 是 200 —— 只看状态码的话这条会被算成发送成功
    expect(r.httpStatus).toBe(200)
    expect(r.detail).toContain('token')
  })

  it('PushPlus 的 token 是密钥字段（必须打码）', () => {
    expect(pushPlusChannel.secretFields).toContain('token')
  })
})

/* ================================================================== */
/* webhook 地址打码                                                    */
/* ================================================================== */

describe('webhook 地址打码（地址本身就是凭据）', () => {
  /*
   * 企微文档原话："一定要保护好消息推送的 webhook 地址，避免泄漏！
   * 否则坏人就可以用你的消息推送来发垃圾消息。"
   *
   * 所以这些地址必须当密钥打码。但整串打成 `http****aaaa` 会让渠道列表
   * 完全失去辨识度 —— 用户分不清哪条是哪个群。所以打码要"抹掉凭据、留下身份"。
   */
  it('飞书：抹掉路径最后一段（token 在路径里）', () => {
    const out = maskSecret('https://open.feishu.cn/open-apis/bot/v2/hook/abc123def456ghi')
    expect(out).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/abc1****6ghi')
  })

  it('钉钉：抹掉 access_token，但保留 /robot/send 这个端点名', () => {
    const out = maskSecret('https://oapi.dingtalk.com/robot/send?access_token=693a91f6abcd97a00')
    expect(out).toContain('/robot/send?')
    expect(out).not.toContain('693a91f6abcd97a00')
    expect(out).toContain('693a****7a00')
  })

  it('企业微信：抹掉 key，但保留 /webhook/send', () => {
    const out = maskSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0')
    expect(out).toContain('/cgi-bin/webhook/send?')
    expect(out).not.toContain('4bc4-97a0')
    expect(out).toContain('693a****97a0')
  })

  it('Server 酱：抹掉 SendKey，但保留 .send 后缀（用户靠它认域名）', () => {
    expect(maskSecret('https://sctapi.ftqq.com/SCTabc123def456.send'))
      .toBe('https://sctapi.ftqq.com/SCTa****f456.send')
    expect(maskSecret('https://12345.push.ft07.com/send/SCTabc123def456.send'))
      .toBe('https://12345.push.ft07.com/send/SCTa****f456.send')
  })

  it('普通密钥仍然是定长打码（不受 URL 逻辑影响）', () => {
    expect(maskSecret('aBcD1234efGh5678')).toBe('aBcD****5678')
    expect(maskSecret('short')).toBe('*****')
  })

  it('打码结果一定是"改过的"（原始凭据不能出现）', () => {
    const secrets = [
      'abc123def456ghi',
      '693a91f6abcd97a00',
      '693a91f6-7xxx-4bc4-97a0',
      'SCTabc123def456',
    ]
    const urls = [
      'https://open.feishu.cn/open-apis/bot/v2/hook/abc123def456ghi',
      'https://oapi.dingtalk.com/robot/send?access_token=693a91f6abcd97a00',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0',
      'https://sctapi.ftqq.com/SCTabc123def456.send',
    ]
    for (let i = 0; i < urls.length; i++) {
      const masked = maskSecret(urls[i]!)
      expect(masked, urls[i]).not.toBe(urls[i])
      expect(masked).toContain('****')
      // 完整原文绝对不能出现在打码结果里
      expect(masked).not.toContain(secrets[i]!)
    }
  })

  it('解析不了的 URL 不会死循环（maskSecret 与 maskUrlCredential 的互调）', () => {
    // 这两个函数互相调用，容易写成无限递归 —— 所以专门守一条
    expect(() => maskSecret('https://')).not.toThrow()
    expect(() => maskSecret('https://[invalid')).not.toThrow()
  })
})

describe('Discord / Slack', () => {
  let mock: MockFetch
  afterEach(() => mock?.restore())

  it('Discord 默认关闭所有 @ 解析（剧名里的 @everyone 不能变成真提醒）', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'discord.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }) } },
    ])
    // 造一条剧名里带 @everyone 的（真实数据里完全可能出现）
    const r = await discordChannel.send(
      { ...MSG, title: '@everyone 本季完结', body: '@here 快来看' },
      { webhookUrl: 'https://discord.com/api/webhooks/1234567890/token-abc' },
    )
    expect(r.ok).toBe(true)
    expect(sent.allowed_mentions).toEqual({ parse: [] })
    // 明确开启时也只放开 users/roles —— @everyone / @here 永远不允许
    mock.restore()
    mock = installMockFetch([
      { match: 'discord.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }) } },
    ])
    await discordChannel.send(MSG, {
      webhookUrl: 'https://discord.com/api/webhooks/1234567890/token-abc',
      allowMentions: true,
    })
    expect((sent.allowed_mentions as { parse: string[] }).parse).toEqual(['users', 'roles'])
    expect((sent.allowed_mentions as { parse: string[] }).parse).not.toContain('everyone')
  })

  it('Discord 204 空响应算成功', async () => {
    mock = installMockFetch([{ match: 'discord.com', reply: () => new Response(null, { status: 204 }) }])
    const r = await discordChannel.send(MSG, { webhookUrl: 'https://discord.com/api/webhooks/1/t' })
    expect(r.ok).toBe(true)
    expect(r.httpStatus).toBe(204)
  })

  it('Discord embed 的 title/description 分别按 256/4096 截断', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'discord.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }) } },
    ])
    await discordChannel.send(
      { ...MSG, title: '标'.repeat(400), body: '文'.repeat(6000) },
      { webhookUrl: 'https://discord.com/api/webhooks/1/t', msgType: 'embed' },
    )
    const embed = (sent.embeds as Array<{ title: string; description: string }>)[0]!
    expect(embed.title.length).toBeLessThanOrEqual(256)
    expect(embed.description.length).toBeLessThanOrEqual(4096)
  })

  it('Discord text 模式按 2000 字符截断（和 embed 不是同一个上限）', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'discord.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }) } },
    ])
    await discordChannel.send(
      { ...MSG, body: '文'.repeat(5000) },
      { webhookUrl: 'https://discord.com/api/webhooks/1/t', msgType: 'text' },
    )
    expect(String(sent.content).length).toBeLessThanOrEqual(2000)
    expect(sent).not.toHaveProperty('embeds')
  })

  it('Discord 高优先级用红色（完结集要显眼）', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'discord.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }) } },
    ])
    await discordChannel.send({ ...MSG, priority: 'high' }, { webhookUrl: 'https://discord.com/api/webhooks/1/t' })
    expect((sent.embeds as Array<{ color: number }>)[0]!.color).toBe(0xed4245)
  })

  it('Discord 429 从 body 的 retry_after 读出退避秒数（响应头里没有）', async () => {
    mock = installMockFetch([
      {
        match: 'discord.com',
        reply: () =>
          new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 1.734, global: false }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    ])
    const r = await discordChannel.send(MSG, { webhookUrl: 'https://discord.com/api/webhooks/1/t' })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(429)
    // 1.734 秒要向上取整成 2 —— 取整方向错了会在限流窗口里继续撞墙
    expect(r.retryAfterSeconds).toBe(2)
    expect(r.detail).toContain('限流')
  })

  /*
   * 实测得到的真实响应：HTTP 404 + `{"code":10015,"message":"Unknown Webhook"}`。
   * Discord 用的是**自己的数字码**，不是 HTTP 状态码 ——
   * 按 404 写映射会全部落空，界面上只剩一句英文。
   */
  it('Discord 实测的 10015（Unknown Webhook）要能翻译', async () => {
    mock = installMockFetch([
      {
        match: 'discord.com',
        reply: () => new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        }),
      },
    ])
    const r = await discordChannel.send(MSG, { webhookUrl: 'https://discord.com/api/webhooks/1/t' })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(404)
    expect(r.detail).toContain('10015')
    expect(r.detail).toContain('webhook 不存在')
  })

  it('Discord 50027（token 无效）也能翻译', async () => {
    mock = installMockFetch([
      {
        match: 'discord.com',
        reply: () => new Response(JSON.stringify({ message: 'Invalid Webhook Token', code: 50027 }), {
          status: 401, headers: { 'Content-Type': 'application/json' },
        }),
      },
    ])
    const r = await discordChannel.send(MSG, { webhookUrl: 'https://discord.com/api/webhooks/1/t' })
    expect(r.detail).toContain('token 无效')
  })

  it('Slack 成功响应是纯文本 ok（不是 JSON）', async () => {
    mock = installMockFetch([
      { match: 'hooks.slack.com', reply: () => new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }) },
    ])
    const r = await slackChannel.send(MSG, { webhookUrl: 'https://hooks.slack.com/services/T1/B1/xxxx' })
    expect(r.ok).toBe(true)
  })

  it('Slack HTTP 200 但 body 不是 ok → 判失败（不能只看状态码）', async () => {
    mock = installMockFetch([
      { match: 'hooks.slack.com', reply: () => new Response('invalid_payload', { status: 200, headers: { 'Content-Type': 'text/plain' } }) },
    ])
    const r = await slackChannel.send(MSG, { webhookUrl: 'https://hooks.slack.com/services/T1/B1/xxxx' })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(200)
    expect(r.detail).toContain('invalid_payload')
  })

  it('Slack 的失败原因是短字符串，要翻译成人话', async () => {
    const cases: Array<[string, string]> = [
      ['no_service', '重新创建'],
      ['channel_is_archived', '归档'],
      ['action_prohibited', '管理员'],
    ]
    for (const [body, word] of cases) {
      mock?.restore()
      mock = installMockFetch([
        { match: 'hooks.slack.com', reply: () => new Response(body, { status: 404, headers: { 'Content-Type': 'text/plain' } }) },
      ])
      const r = await slackChannel.send(MSG, { webhookUrl: 'https://hooks.slack.com/services/T1/B1/x' })
      expect(r.ok, body).toBe(false)
      expect(r.detail, body).toContain(word)
    }
  })

  it('Slack header 块按 150 字符截断（平台会 400 拒绝超长 header）', async () => {
    let sent: Record<string, unknown> = {}
    mock = installMockFetch([
      { match: 'hooks.slack.com', reply: (_u, init) => { sent = JSON.parse(String(init?.body)); return new Response('ok') } },
    ])
    await slackChannel.send({ ...MSG, title: '标'.repeat(300) }, { webhookUrl: 'https://hooks.slack.com/services/T1/B1/x' })
    const blocks = sent.blocks as Array<{ type: string; text: { text: string } }>
    expect(blocks[0]!.type).toBe('header')
    expect(blocks[0]!.text.text.length).toBeLessThanOrEqual(150)
    // 还要有 text 兜底 —— 部分客户端的通知栏只读 text 字段
    expect(typeof sent.text).toBe('string')
    expect((sent.text as string).length).toBeLessThanOrEqual(150)
  })

  it('Slack 429 从 Retry-After 响应头读退避秒数', async () => {
    mock = installMockFetch([
      {
        match: 'hooks.slack.com',
        reply: () =>
          new Response('rate_limited', { status: 429, headers: { 'Retry-After': '5' } }),
      },
    ])
    const r = await slackChannel.send(MSG, { webhookUrl: 'https://hooks.slack.com/services/T1/B1/x' })
    expect(r.ok).toBe(false)
    expect(r.retryAfterSeconds).toBe(5)
  })

  it('两家的 webhook 地址都按凭据打码，但保留可辨识部分', () => {
    // Discord：ID 留着（单独无害），token 抹掉；Slack：T/B 留着，最后一段抹掉
    expect(maskSecret('https://discord.com/api/webhooks/1234567890/abcdefghijklmnop'))
      .toBe('https://discord.com/api/webhooks/1234567890/abcd****mnop')
    expect(maskSecret('https://hooks.slack.com/services/T00000000/B00000000/abcdefghijkl'))
      .toBe('https://hooks.slack.com/services/T00000000/B00000000/abcd****ijkl')
  })

  it('非官方域名直接拒绝', async () => {
    mock = installMockFetch([{ match: 'http', reply: () => new Response('ok') }])
    for (const [def, url] of [
      [discordChannel, 'https://discord.com.attacker.net/api/webhooks/1/t'],
      [slackChannel, 'https://hooks.slack.com.attacker.net/services/a/b/c'],
      [discordChannel, 'https://evil.com/api/webhooks/1/t'],
    ] as const) {
      const r = await (def as { send: (m: unknown, c: unknown) => Promise<{ ok: boolean; detail: string }> })
        .send(MSG, { webhookUrl: url })
      expect(r.ok, url).toBe(false)
      expect(r.detail, url).toContain('官方地址')
    }
    expect(mock.log).toHaveLength(0)
  })
})

/* ================================================================== */
/* 注册表                                                              */
/* ================================================================== */

describe('渠道注册表', () => {
  it('国内渠道都注册了', () => {
    for (const t of ['feishu', 'dingtalk', 'wecom', 'serverchan', 'pushplus']) {
      expect(getChannel(t), t).toBeDefined()
    }
    expect(supportedTypes()).toContain('bark')
  })

  it('每个渠道要么声明 https 使用说明，要么显式豁免', () => {
    // 没有单一官方文档的渠道必须显式列在这里；不要为了过测试硬塞一个无关链接。
    const docsExempt = new Set(['webhook'])
    const missing: string[] = []

    for (const type of supportedTypes()) {
      const url = getChannel(type)?.docsUrl
      if (docsExempt.has(type)) {
        expect(url, type).toBeUndefined()
        continue
      }
      if (!url) {
        missing.push(type)
        continue
      }
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' || !parsed.hostname) missing.push(type)
      } catch {
        missing.push(type)
      }
    }

    expect(missing).toEqual([])
  })

  it('每个渠道的必填字段都有 label（前端表单要显示）', () => {
    for (const def of [feishuChannel, dingtalkChannel, wecomChannel, serverChanChannel, pushPlusChannel]) {
      for (const f of def.configFields) {
        expect(f.label, `${def.type}.${f.name}`).toBeTruthy()
        expect(f.type).toMatch(/^(text|password|url|select|boolean)$/)
      }
    }
  })

  it('url 类型的官方渠道都必须带域名白名单（防止漏配）', () => {
    for (const def of [feishuChannel, dingtalkChannel, wecomChannel, serverChanChannel]) {
      const urlFields = def.configFields.filter((f) => f.type === 'url')
      expect(urlFields.length, def.type).toBeGreaterThan(0)
      for (const f of urlFields) {
        expect(f.allowedHostSuffixes, `${def.type}.${f.name}`).toBeTruthy()
        expect(f.allowedHostSuffixes!.length).toBeGreaterThan(0)
      }
    }
  })

  it('send 都接受 opts.signal（超时保护依赖它）', () => {
    // 类型上已经保证，这里做一个运行时形状检查，防止有人改签名时漏掉某个渠道
    for (const def of [feishuChannel, dingtalkChannel, wecomChannel, serverChanChannel, pushPlusChannel]) {
      expect(def.send.length, def.type).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('发送超时', () => {
  let mock: MockFetch
  afterEach(() => mock?.restore())

  it('渠道把 opts.signal 透传给了 fetch（否则超时形同虚设）', async () => {
    let seen: AbortSignal | undefined
    mock = installMockFetch([
      { match: 'open.feishu.cn', reply: (_u, init) => {
        seen = init?.signal ?? undefined
        return new Response(JSON.stringify({ code: 0 }))
      } },
    ])
    const controller = new AbortController()
    const r = await feishuChannel.send(
      MSG,
      { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
      { signal: controller.signal },
    )
    expect(r.ok).toBe(true)
    // 必须是**同一个** signal 对象，不能是渠道自己新造的
    expect(seen).toBe(controller.signal)
  })

  it('fetch 因超时抛错时，转成可读原因而不是把堆栈丢给用户', async () => {
    mock = installMockFetch([
      { match: 'open.feishu.cn', reply: () => { throw new DOMException('The operation was aborted', 'TimeoutError') } },
    ])
    const r = await feishuChannel.send(
      MSG,
      { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
      { signal: AbortSignal.timeout(1) },
    )
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('超时')
  })

  it('所有渠道都支持传入 signal', async () => {
    const ctrl = new AbortController()
    for (const [def, cfg] of [
      [dingtalkChannel, { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=a' }],
      [wecomChannel, { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' }],
      [serverChanChannel, { webhookUrl: 'https://sctapi.ftqq.com/SCTa.send' }],
      [pushPlusChannel, { token: 'tk' }],
    ] as const) {
      mock?.restore()
      mock = installMockFetch([{ match: 'http', reply: { code: 0 } }])
      const r = await (def as { send: (m: unknown, c: unknown, o?: { signal?: AbortSignal }) => Promise<{ ok: boolean }> })
        .send(MSG, cfg, { signal: ctrl.signal })
      // 只要没抛"不支持 signal"之类的问题即可；具体结果不关心
      expect(typeof r.ok, def.type).toBe('boolean')
    }
  })
})

/* ================================================================== */
/* 出站请求的安全约束                                                  */
/* ================================================================== */

/**
 * 剥掉注释，只留代码再扫。
 *
 * ⚠️ `//` 必须排除 `https://` 里的那两个斜杠 —— 否则从那里到行尾全被切掉，
 *    万一那行正好有 `msg.image` 就会被误判成"没用到"。
 */
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlocks.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('出站请求的安全约束', () => {
  let mock: MockFetch | null = null
  afterEach(() => { mock?.restore(); mock = null })

  const CHANNEL_DIR = fileURLToPath(new URL('../src/channels', import.meta.url))
  // 这些不是渠道实现：注册表只做装配，types/sign/enrich 没有出站请求
  // （enrich 是图片策略与链接模板的纯加工层，见 enrich.ts 的文件头）
  const NON_CHANNELS = new Set(['types.ts', 'registry.ts', 'sign.ts', 'enrich.ts'])

  it('每个渠道都同时带上了 signal 和 redirect: manual', () => {
    // 这两条都不能靠"新渠道作者记得写"：
    //   signal  —— 漏了就等于这个渠道没有超时保护，一个挂住的 webhook 会拖垮整轮 tick
    //   redirect —— fetch 默认跟随跳转，于是 assertSafeUrl 的
    //               "只允许 https + 禁止内网"可以被一个 302 绕过
    //               （公开域名跳到 http://169.254.169.254/ 就穿过去了）
    //               ⚠️ 必须 'manual' 而非 'error'：Cloudflare Workers 的 fetch
    //               只认 'follow'/'manual'，传 'error' 会直接抛，线上实测过。
    // 所以这里直接扫源码：fetch 有几处，两个约束就该有几处。
    const offenders: string[] = []
    for (const f of readdirSync(CHANNEL_DIR).filter((x) => x.endsWith('.ts') && !NON_CHANNELS.has(x))) {
      const src = readFileSync(join(CHANNEL_DIR, f), 'utf8')
      const fetches = (src.match(/await fetch\(/g) ?? []).length
      const signals = (src.match(/signal: opts\?\.signal/g) ?? []).length
      const redirects = (src.match(/redirect: 'manual'/g) ?? []).length
      if (fetches === 0) { offenders.push(`${f}: 没找到 fetch，检查一下这个文件还是不是渠道`); continue }
      if (fetches !== signals) offenders.push(`${f}: fetch ${fetches} 处 / signal ${signals} 处`)
      if (fetches !== redirects) offenders.push(`${f}: fetch ${fetches} 处 / redirect ${redirects} 处`)
    }
    expect(offenders).toEqual([])
  })

  /**
   * 🔴 声明的 `supportsImage` 必须和实现一致。
   *
   * 它决定前端**要不要显示**图片那两个字段（见 types.ts 的说明）。两头发散的表现
   * 都很安静：声明了支持但 `send()` 不读 `msg.image` ⇒ 用户配了没反应；
   * 实现了发图却没声明 ⇒ 界面上根本没有这个选项。**两种都不会报错**，
   * 所以只能扫源码比对（注释要先剥掉，否则"刻意不带海报"那句说明也会被数进去）。
   */
  it('声明支持图片 ⟺ send() 真的读 msg.image', () => {
    const offenders: string[] = []
    for (const f of readdirSync(CHANNEL_DIR).filter((x) => x.endsWith('.ts') && !NON_CHANNELS.has(x))) {
      const type = f.replace(/\.ts$/, '')
      const def = getChannel(type)
      if (!def) { offenders.push(`${f}: 找不到注册的渠道，文件名与 type 不一致？`); continue }
      const src = readFileSync(join(CHANNEL_DIR, f), 'utf8')
      const uses = stripComments(src).includes('msg.image')
      if (uses !== def.supportsImage) {
        offenders.push(`${type}: 声明 supportsImage=${def.supportsImage}，但源码里${uses ? '用到了' : '没有'} msg.image`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('302 响应被判为失败，不会当成发送成功', async () => {
    mock = installMockFetch([
      {
        match: 'open.feishu.cn',
        reply: () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }),
      },
    ])
    const r = await feishuChannel.send(MSG, {
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x',
    })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(302)
  })

  it('被拒绝的重定向会翻译成人话，而不是光一句 fetch failed', () => {
    // 渠道现在用 `redirect: 'manual'`，3xx 走响应码判定、不抛异常（见上一条测试）。
    // 但仍有运行时/库会因重定向抛 TypeError('fetch failed')，真正的原因在 cause 里。
    // 直接透出 message 的话用户只会看到 "fetch failed"，完全不知道是被主动拒绝的，
    // 所以 describeFetchError 保留这条翻译兜底。
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: new Error('unexpected redirect'),
    })
    expect(describeFetchError(err)).toContain('重定向')
  })

  it('webhook 模板里的未知占位符会被提示（而不是静默渲染成空串）', () => {
    const webhook = getChannel('webhook')!
    const warn = (bodyTemplate: string) =>
      (webhook.validate as (c: Record<string, unknown>) => string[])({ bodyTemplate })

    // 拼错一个字母就静默丢内容 —— 推送照发，只是少一块，用户根本联想不到
    const misspelled = warn('{"text":"{{titel}}"}')
    expect(misspelled).toHaveLength(1)
    expect(misspelled[0]).toContain('{{titel}}')

    // 正常模板 / 没填模板都不该有噪音。
    // 注意 {{json:title}} 是合法写法（同样几个字段，值做 JSON 转义），
    // {{json}} 是整体对象 —— 两者都不该报警。
    expect(warn('{{title}} / {{body}} / {{json:title}} / {{json}}')).toEqual([])
    expect(warn('')).toEqual([])

    // 同一个错拼出现多次只提示一次
    expect(warn('{{x}}{{x}}{{x}}')[0]!.match(/\{\{x\}\}/g)).toHaveLength(1)
  })
})

/* ================================================================== */
/* 表单默认值（ChannelConfigField.default）                            */
/* ================================================================== */

/*
 * Bark 的「服务地址」不能只给 placeholder（灰字提示，**框里是空的**）：
 * 它是 required，用户得把一个我们本来就知道的地址手敲一遍，
 * 敲错了还要等到"发送测试"时才报错。
 *
 * 这里钉两条不变式：
 *   1. 默认值不能设在密钥字段上。预填一个假密钥会被当成"已有值"，
 *      比空着更误导（用户以为配好了）。
 *   2. 默认值必须是**真正能用**的地址 —— 断言请求确实打到它。
 *      防的是"表单填 A、实际发到 B"：默认值与 send 的兜底分成两处字面量
 *      就会出这种事，所以两边共用同一个常量（见各渠道的 DEFAULT_SERVER_URL）。
 */
describe('渠道字段的表单默认值', () => {
  let mock: MockFetch
  afterEach(() => mock?.restore())

  it('默认值只出现在非密钥字段，且非空', () => {
    for (const type of supportedTypes()) {
      const ch = getChannel(type)!
      for (const f of ch.configFields) {
        if (f.default === undefined) continue
        expect(ch.secretFields, `${type}.${f.name} 是密钥字段，不该有默认值`).not.toContain(f.name)
        expect(f.default, `${type}.${f.name} 的默认值是空串`).not.toBe('')
        expect(f.type, `${type}.${f.name} 是密码框`).not.toBe('password')
      }
    }
  })

  /**
   * `label` / `help` / `placeholder` 是**纯文本**（前端只做 `esc()`，没有 markdown）。
   *
   * 写 `**强调**` 会把星号原样印到界面上 —— 用户看到 `不是` 这种东西，
   * 比没强调更糟，而且**极难自查**：源码里星号是有意义的 markdown，
   * 只有渲染出来才看得出问题（这次就是用户截图报出来的）。
   */
  it('字段文案里不许出现 markdown 星号', () => {
    for (const type of supportedTypes()) {
      const ch = getChannel(type)!
      for (const f of ch.configFields) {
        for (const [where, text] of [
          ['label', f.label],
          ['help', f.help],
          ['placeholder', f.placeholder],
        ] as const) {
          if (!text) continue
          expect(text, `${type}.${f.name} 的 ${where} 里有 **，会原样显示`).not.toContain('**')
        }
      }
    }
  })

  /**
   * `select` 的选项文案**只放名称，不放括号说明**。
   *
   * 为什么不许：下拉框宽度有限，每一项都会被截断 ——
   * "固定图片（填下面的地址）"在框里只剩"固定图片（…"，用户既看不出当前选了什么，
   * 也读不到那句说明（它本来也不是给这里看的）。补充说明写进 `help`，那里不截断。
   *
   * ⚠️ 这条只查 **option 的 label**，不查字段的 `label`：
   *   字段标签独占一行、有完整宽度，"静默发送（不响铃）"那种补充是有用的。
   */
  it('下拉选项里不许带括号说明（会截断，要说明就写进 help）', () => {
    for (const type of supportedTypes()) {
      const ch = getChannel(type)!
      for (const f of ch.configFields) {
        if (f.type !== 'select' || !f.options) continue
        for (const o of f.options) {
          // 半角 () 同样禁掉 —— 那不是"英文括号"，只是手滑
          expect(o.label, `${type}.${f.name} 的选项「${o.label}」里有括号，去掉后写进 help`)
            .not.toMatch(/[（(]/)
        }
      }
    }
  })

  /**
   * 🔴 `help` 不许解释"条件显示"。
   *
   * `showIf` 已经把这件事表达清楚了 —— 选了「固定图片」，下面自然出现地址框。
   * 再用 help 念一遍"选固定图片后下面才出现地址输入框"，是拿界面文案去
   * 复述界面已经做出来的事：用户先看到框、再读到解释，反而要确认自己是不是
   * 看错了。这三句（图片 / 点击跳转 / 通知图标）都是这么被要求删掉的。
   *
   * 留着的 help 应该是**界面上看不到的信息**：格式要求、从哪复制、
   * 平台限额、为什么推荐某个选项。
   */
  it('help 不许复述条件显示（"选 X 后下面才出现…"）', () => {
    for (const type of supportedTypes()) {
      const ch = getChannel(type)!
      for (const f of ch.configFields) {
        if (!f.help) continue
        expect(f.help, `${type}.${f.name} 的 help 在复述 showIf：${f.help}`)
          .not.toMatch(/(下面|下方).{0,4}才(出现|显示)|才出现(输入框|地址框)/)
      }
    }
  })

  it('Bark 的服务地址默认值就是请求真正打到的地址', async () => {
    const def = getChannel('bark')!.configFields.find((f) => f.name === 'serverUrl')!.default!
    mock = installMockFetch([{ match: 'api.day.app', reply: { code: 200, message: 'ok' } }])
    const r = await barkChannel.send(MSG, { serverUrl: def, deviceKey: 'k' })
    expect(r.ok).toBe(true)
    expect(mock.log.some((l) => l.url === `${def}/push`)).toBe(true)
  })

  it('ntfy 的服务地址默认值就是请求真正打到的地址', async () => {
    const def = getChannel('ntfy')!.configFields.find((f) => f.name === 'serverUrl')!.default!
    mock = installMockFetch([{ match: 'ntfy.sh', reply: () => new Response('ok', { status: 200 }) }])
    const r = await ntfyChannel.send(MSG, { serverUrl: def, topic: 'demo-topic' })
    expect(r.ok).toBe(true)
    expect(mock.log.some((l) => l.url === `${def}/demo-topic`)).toBe(true)
  })

  it('留空时也走同一个默认地址（表单没填/接口调用省略都算）', async () => {
    mock = installMockFetch([{ match: 'api.day.app', reply: { code: 200, message: 'ok' } }])
    const r = await barkChannel.send(MSG, { serverUrl: '', deviceKey: 'k' })
    expect(r.ok).toBe(true)
    expect(mock.log.some((l) => l.url.startsWith('https://api.day.app/'))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* 字段默认值（withDefaults）                                          */
/* ------------------------------------------------------------------ */

describe('补默认值：default 是字段自己声明的合法答案', () => {
  it('缺失的键补上默认值（Bark 服务地址）', () => {
    const out = withDefaults('bark', { deviceKey: 'k' })
    expect(out.serverUrl).toBe('https://api.day.app')
  })

  it('用户填过的值原样保留（自建 bark-server 不能被默认值盖掉）', () => {
    const out = withDefaults('bark', { deviceKey: 'k', serverUrl: 'https://bark.example.com' })
    expect(out.serverUrl).toBe('https://bark.example.com')
  })

  it('空串**不**补：那表示用户自己清空了，该被必填校验拦住', () => {
    // 界面的预填逻辑也是这个分界（raw != null 才用用户值），两边必须一致
    expect(withDefaults('bark', { serverUrl: '' }).serverUrl).toBe('')
    expect(withDefaults('bark', { serverUrl: '   ' }).serverUrl).toBe('   ')
  })

  it('不改动传入的对象（调用方还持有它）', () => {
    const input = { deviceKey: 'k' }
    withDefaults('bark', input)
    expect('serverUrl' in input).toBe(false)
  })

  it('未知渠道类型原样返回（别在这里抛）', () => {
    const input = { url: 'https://x' }
    expect(withDefaults('nope', input)).toBe(input)
  })

  it('每个带 default 的非密钥字段都会被补齐（含公共能力注入的那些）', () => {
    const out = withDefaults('bark', { deviceKey: 'k' })
    // imageMode 这类公共字段（registry 统一注入）同样有默认值 ⇒ 不会被判"缺"
    expect(out.imageMode).toBe('poster')
    // 密钥字段永远不预填默认值（预填假密钥会被当成用户填的）
    expect('deviceKey' in out).toBe(true)
    const ntf = withDefaults('ntfy', { topic: 't' })
    expect(Object.keys(ntf)).not.toContain('password')
  })
})

/* ------------------------------------------------------------------ */
/* 默认值必须是"真默认值"（2026-10-05）                                 */
/* ------------------------------------------------------------------ */

describe('下拉字段的默认值必须是自己选项里的一个', () => {
  /**
   * 为什么钉：默认值是**给界面预填 + 存进配置**用的（`withDefaults`）。
   * 一旦它不在 `options` 里，界面会回退显示第一项，而库里存的是另一个值 ——
   * 于是"界面上选的是 A、实际发出去按 B"，而且不报任何错。
   */
  it('所有渠道：select 字段的 default ∈ options', () => {
    const bad: string[] = []
    for (const type of supportedTypes()) {
      for (const f of getChannel(type)!.configFields) {
        if (f.type !== 'select' || f.default === undefined) continue
        if (!(f.options ?? []).some((o) => o.value === f.default)) bad.push(`${type}.${f.name}=${f.default}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('Bark：分组 / 图标 / 归档 / 图片 都用上了真默认值', () => {
    // 这几项是用户 2026-10-05 明确要求的"就用框里显示的这些"
    const out = withDefaults('bark', { deviceKey: 'k' })
    expect(out.group).toBe('Trakt 播出提醒')
    expect(out.iconMode).toBe('poster')
    expect(out.archive).toBe('true')
    // 公共的「图片」本来就有默认值，现在会被一起补进配置
    expect(out.imageMode).toBe('poster')
  })

  it('Bark：清空分组框会回落到"按规则名分组"（默认值只补没碰过的）', () => {
    // send 里是 `cfg.group || msg.group`，而 msg.group 就是规则名
    const out = withDefaults('bark', { deviceKey: 'k', group: '' })
    expect(out.group).toBe('')
  })

  it('其他渠道：默认值与各自 send() 的兜底一致（逐个核对过才写上来的）', () => {
    expect(withDefaults('telegram', { token: 't', chatId: 'c' }).parseMode).toBe('MarkdownV2')
    expect(withDefaults('webhook', { url: 'https://x' }).method).toBe('POST')
    expect(withDefaults('feishu', { webhookUrl: 'https://x' }).msgType).toBe('post')
    expect(withDefaults('feishu', { webhookUrl: 'https://x' }).cardColor).toBe('blue')
    expect(withDefaults('discord', { webhookUrl: 'https://x' }).msgType).toBe('embed')
    expect(withDefaults('slack', { webhookUrl: 'https://x' }).msgType).toBe('blocks')
    expect(withDefaults('dingtalk', { webhookUrl: 'https://x', secret: 's' }).msgType).toBe('markdown')
    expect(withDefaults('wecom', { webhookUrl: 'https://x' }).msgType).toBe('markdown')
    expect(withDefaults('pushplus', { token: 't' }).template).toBe('markdown')
  })

  it('ntfy 的「跟随通知级别」保持空缺 —— 那是它的第一项，且必须继续由优先级决定', () => {
    // send 里是 `cfg.priority || toNtfyPriority(msg.priority)`，写死任何值都会废掉这层映射
    const f = getChannel('ntfy')!.configFields.find((x) => x.name === 'priority')!
    expect(f.options?.[0]?.value).toBe('')
    expect(f.default).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* 成功时 detail 必须是 'ok'（2026-10-05）                              */
/* ------------------------------------------------------------------ */

/**
 * 🔴 **`detail` 会写进 `deliveries.last_error`**（`markSent` 也写），
 * 日志页把它当**错误信息**用红色 `.err` 显示。
 * 所以渠道成功时把响应原文带出去（原来 Bark 返回 `code=200 success`），
 * 症状就是**成功的投递在界面上显示成红色的失败详情**。
 *
 * 各渠道统一：成功 ⇒ `detail === 'ok'`；`last_error` 只装真正的失败原因。
 */
describe('成功时 detail 恒为 ok（否则日志页把成功显示成红色错误）', () => {
  // ⚠️ `mock` 是各 describe 自己的局部变量（fetch 是全局替换，必须每个用例装卸）
  let mock: MockFetch
  afterEach(() => mock?.restore())

  it('Bark：{code:200} ⇒ detail 是 ok，不带响应原文', async () => {
    mock = installMockFetch([{ match: 'api.day.app', reply: { code: 200, message: 'success' } }])
    const r = await barkChannel.send(MSG, { serverUrl: '', deviceKey: 'k' })
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('ok')
    expect(r.detail).not.toContain('success')
  })

  it('Bark：code≠200 仍然失败，且 detail 带上业务码（这才是它该出现的场景）', async () => {
    mock = installMockFetch([
      { match: 'api.day.app', reply: () => new Response(JSON.stringify({ code: 400, message: 'device key invalid' }), { status: 200 }) },
    ])
    const r = await barkChannel.send(MSG, { serverUrl: '', deviceKey: 'k' })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('code=400')
    expect(r.detail).toContain('device key invalid')
  })

  it('Bark：非 JSON 的 2xx 响应 ⇒ detail 是 ok（别把 HTML 正文写进 last_error）', async () => {
    mock = installMockFetch([
      { match: 'api.day.app', reply: () => new Response('<html>hello</html>', { status: 200 }) },
    ])
    const r = await barkChannel.send(MSG, { serverUrl: '', deviceKey: 'k' })
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('ok')
  })

  it('Bark：非 JSON 的 4xx ⇒ 失败且 detail 带原文（排障要看到）', async () => {
    mock = installMockFetch([
      { match: 'api.day.app', reply: () => new Response('bad gateway', { status: 502 }) },
    ])
    const r = await barkChannel.send(MSG, { serverUrl: '', deviceKey: 'k' })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('bad gateway')
  })

  it('平台型渠道（parsePlatformResponse / parseTextResponse）同样恒为 ok', async () => {
    // 钉钉 / 企业微信 / 飞书 / PushPlus 走 parsePlatformResponse，
    // Slack 走 parseTextResponse —— 成功分支都在 types.ts 里，统一钉住。
    const okJson = () => new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 })
    mock = installMockFetch([{ match: 'oapi.dingtalk.com', reply: okJson }])
    const d = await dingtalkChannel.send(MSG, { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=x' })
    expect(d.ok).toBe(true)
    expect(d.detail).toBe('ok')

    mock = installMockFetch([{ match: 'hooks.slack.com', reply: () => new Response('ok', { status: 200 }) }])
    const sl = await slackChannel.send(MSG, { webhookUrl: 'https://hooks.slack.com/services/x' })
    expect(sl.ok).toBe(true)
    expect(sl.detail).toBe('ok')
  })
})
