// 单元测试：纯函数层（不联网）—— parseCookieString / buildCookieHeader / extractCsrfToken / readDesktopLogin 容错
// 通过 _internal 导出避免重复实现。
import { DuMatePlugin, _internal } from "./index.mjs"
import { createGuard, classifyResponse } from "./guard.mjs"

const { parseCookieString, buildCookieHeader, extractCsrfToken } = _internal ?? {}
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

console.log("[U1] parseCookieString")
try {
  const cs = parseCookieString('a=1; b="hello world"; c=x=y;  ;d=4')
  if (cs.length !== 4) throw new Error("count=" + cs.length)
  if (cs[1].value !== "hello world") throw new Error("quoted value")
  if (cs[2].value !== "x=y") throw new Error("first-= split")
  if (cs.every((c) => c.domain === ".baidu.com") !== true) throw new Error("domain default")
  ok("4 items, quoted/unquoted/= in value handled")
} catch (e) { fail("parseCookieString", e) }

console.log("[U2] buildCookieHeader 域名过滤 + 引号规则")
try {
  const cookies = [
    { name: "A", value: "1", domain: ".baidu.com" },
    { name: "B", value: "2", domain: ".bce.baidu.com" },
    { name: "C", value: "3", domain: "passport.baidu.com" },
    { name: "D", value: "has space", domain: ".baidu.com" },
    { name: "E", value: '"pre-quoted"', domain: ".baidu.com" },
  ]
  const h = buildCookieHeader(cookies, "console.bce.baidu.com")
  if (!h.includes("A=1")) throw new Error("A should match")
  if (!h.includes("B=2")) throw new Error("B should match")
  if (h.includes("C=3")) throw new Error("C(passport) should NOT match")
  if (!h.includes('D="has space"')) throw new Error("space needs quotes: " + h)
  if (!h.includes("E=pre-quoted")) throw new Error("pre-quoted stripped: " + h)
  ok("domain filter + re-quote correct")
} catch (e) { fail("buildCookieHeader", e) }

console.log("[U3] extractCsrfToken")
try {
  const cookies = [
    { name: "bce-user-info", value: '"tok123"', domain: ".bce.baidu.com" },
    { name: "bce-user-info", value: "other", domain: ".passport.baidu.com" },
  ]
  const t = extractCsrfToken(cookies, "console.bce.baidu.com")
  if (t !== "tok123") throw new Error("got " + t)
  ok("picks matching-domain cookie, strips quotes")
} catch (e) { fail("extractCsrfToken", e) }

console.log("[U4] 未登录 loader / usage / checkin 快速路径")
try {
  const hooks = await DuMatePlugin({})
  const noAuth = async () => ({})
  const u = await hooks.auth.usage(noAuth)
  if (!(u.error && u.signIn === "kept")) throw new Error("usage no-auth shape")
  const c = await hooks.auth.checkin(noAuth)
  if (c.outcome !== "failed") throw new Error("checkin no-auth shape")
  const l = await hooks.auth.loader(noAuth)
  const res = await l.fetch("https://example.invalid/x", { method: "POST", body: "{}" })
  if (res.status !== 401 || res.headers.get("x-magpie-sign-in") !== "expired") throw new Error("loader no-auth 401")
  ok("all three hooks degrade gracefully")
} catch (e) { fail("no-auth paths", e) }

console.log("[U5] 损坏 auth.json / 缺 .cookie-key 时不崩")
try {
  process.env.DUMATE_USER_DATA_DIR = "Z:/definitely/not/exist"
  // bust ESM cache with a query string
  const m = await import("./index.mjs?broken=" + Date.now())
  const hooks2 = await m.DuMatePlugin({})
  const flow = await hooks2.auth.methods[0].authorize()
  const r = await flow.callback()
  if (r.type !== "failed") throw new Error("should fail gracefully, got " + JSON.stringify(r).slice(0, 100))
  ok("desktop login missing dir -> friendly failure")
  delete process.env.DUMATE_USER_DATA_DIR
} catch (e) { fail("broken desktop login", e) }

console.log("[U6] 图标：auth.icon 是非空 data:image URI，且带真实 PNG 魔数")
try {
  const hooks = await DuMatePlugin({})
  const icon = hooks.auth.icon
  if (typeof icon !== "string") throw new Error("auth.icon 应为字符串，实际 " + typeof icon)
  if (!icon.startsWith("data:image/")) throw new Error("图标不是 data:image URI")
  if (icon.length < 200) throw new Error("图标内容过短，可能是空壳: " + icon.slice(0, 40))
  if (icon.length > 1024 * 1024) throw new Error("超出 magpie 的 1MB 上限")
  // 优先取桌面端真实图标时应为 PNG（含 PNG 魔数 iVBORw0KGgo）；回退为 SVG。
  const isPng = icon.startsWith("data:image/png;base64,")
  const isSvg = icon.startsWith("data:image/svg+xml;base64,")
  if (!isPng && !isSvg) throw new Error("未知图标类型: " + icon.slice(0, 30))
  if (isPng && !icon.includes("iVBORw0KGgo")) throw new Error("PNG data URI 缺魔数，base64 可能损坏")
  ok(`auth.icon OK（${isPng ? "桌面端 PNG" : "内置 SVG 回退"}，${Math.round(icon.length / 1024)}KB）`)
} catch (e) { fail("auth.icon", e) }

console.log("[U7] 图标回退：桌面端不可用时仍给出内置矢量，且绝不抛错")
try {
  const { iconFromDesktopApp, iconFromBundle } = _internal ?? {}
  if (typeof iconFromBundle !== "function") throw new Error("iconFromBundle 未导出")
  const svgIcon = iconFromBundle()
  if (!svgIcon.startsWith("data:image/svg+xml;base64,")) throw new Error("内置图标非 SVG data URI")
  // 解码回来必须是合法 svg 根元素——防 base64 或文件内容损坏却"看起来成功"
  const decoded = Buffer.from(svgIcon.split(",")[1], "base64").toString("utf8")
  if (!decoded.trimStart().startsWith("<svg")) throw new Error("解码后不是 svg: " + decoded.slice(0, 40))
  if (!decoded.includes('viewBox="0 0 512 512"')) throw new Error("svg 缺 512 viewBox")
  // 指向不存在的 userData 目录时必须安静返回空串（不得抛异常拖垮插件加载）。
  // 直接调函数即可：desktopUserDataDir() 每次读 env，无需重新 import
  // （用 ?query 重新 import 会让 import.meta.url 带 query，反而打乱 icon.svg 的解析）。
  const prev = process.env.DUMATE_USER_DATA_DIR
  process.env.DUMATE_USER_DATA_DIR = "Z:/definitely/not/exist"
  const fromMissing = iconFromDesktopApp()
  if (prev === undefined) delete process.env.DUMATE_USER_DATA_DIR
  else process.env.DUMATE_USER_DATA_DIR = prev
  if (fromMissing !== "") throw new Error("无桌面端时应返回空串，实际: " + String(fromMissing).slice(0, 40))
  ok("回退链完整：桌面端缺失 → 内置 SVG，且不抛错")
} catch (e) { fail("图标回退", e) }

console.log("[U8] 装了桌面端时应取到官方图标（真 PNG，非回退矢量）")
try {
  const { iconFromDesktopApp } = _internal ?? {}
  const fromApp = iconFromDesktopApp()
  if (!fromApp) {
    // 没装 DuMate 的机器上这条不成立，跳过而不是判失败——否则换机器就红。
    console.log("  SKIP 本机未检测到 DuMate 桌面端，U8 不适用")
  } else {
    if (!fromApp.startsWith("data:image/png;base64,")) throw new Error("桌面端图标应为 PNG")
    if (!fromApp.includes("iVBORw0KGgo")) throw new Error("PNG 魔数缺失")
    // 真正解码一次：官方 512 图标解码后必须以 PNG 签名开头（\x89PNG）
    const raw = Buffer.from(fromApp.split(",")[1], "base64")
    if (raw.length < 1024) throw new Error("图标字节数过小: " + raw.length)
    if (!(raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47)) {
      throw new Error("解码后不是合法 PNG，前 4 字节: " + raw.subarray(0, 4).toString("hex"))
    }
    ok(`官方图标解码校验通过（${Math.round(raw.length / 1024)}KB，PNG 签名正确）`)
  }
} catch (e) { fail("官方图标", e) }

console.log("[U9] 插件自带 icon.png 优先于客户端图标（复制进插件才是自包含）")
try {
  const { iconFromPluginDir } = _internal ?? {}
  if (typeof iconFromPluginDir !== "function") throw new Error("iconFromPluginDir 未导出")
  const bundled = iconFromPluginDir()
  if (!bundled) {
    // 用户还没把 PNG 复制进插件目录。这条不算失败——但要说清楚现在走的是哪一级，
    // 否则"图标能用"会掩盖掉"插件其实不自包含"这件事。
    console.log("  SKIP 插件目录内暂无 icon.png（当前依赖客户端或 SVG 兜底；把客户端 icons/256x256.png 复制为 icon.png 即可自包含）")
  } else {
    if (!bundled.startsWith("data:image/png;base64,")) throw new Error("插件内 icon.png 应被识别为 PNG")
    const raw = Buffer.from(bundled.split(",")[1], "base64")
    if (!(raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47)) {
      throw new Error("icon.png 不是合法 PNG（签名不符）—— 复制时可能存成了别的内容")
    }
    if (bundled.length > 1024 * 1024) throw new Error("icon.png 编码后超过 magpie 1MB 上限")
    // 优先级验证：最终的 auth.icon 必须落在插件自带这份上。
    const hooks = await DuMatePlugin({})
    if (hooks.auth.icon !== bundled) throw new Error("优先序错误：auth.icon 没采用插件自带的 icon.png")
    ok(`插件自带 icon.png 生效（${Math.round(raw.length / 1024)}KB），且优先于客户端图标`)
  }
} catch (e) { fail("插件自带图标", e) }

// Cookie 值来自加密文件和解密后的粘贴串，两者都可能被人塞进带 CR/LF 的内容。
// 裸的 CR/LF 会把我们自己构造的 Cookie 头切成两行，等于凭空多出一条请求头 ——
// 这是头注入的唯一真实入口，判据就是「拼出来的头里不允许出现 CR 或 LF」。
console.log("[U10] Cookie 头：控制字符与非法名一律丢弃")
try {
  const hostile = [
    { name: "bce-sessionid", value: "legit" },
    { name: "bad name", value: "x" },
    { name: "spaced name", value: "y" },
    { name: "evil", value: "a\r\nX-Injected: 1" },
    { name: "", value: "z" },
  ]
  const header = buildCookieHeader(hostile, "console.bce.baidu.com")
  if (/[\r\n\u0000]/.test(header)) throw new Error("拼出的 Cookie 头里仍有 CR/LF/NUL")
  if (!header.includes("bce-sessionid=legit")) throw new Error("正常 cookie 被误删")
  if (/bad name|spaced name/.test(header)) throw new Error("含空格的非法名没有被过滤")
  // 值里的控制字符被剥掉，剩下的内容仍在（不静默丢整条 cookie）
  if (!header.includes("evil=")) throw new Error("带控制字符的合法 cookie 被整条丢弃")

  const parsed = parseCookieString("bad name=x; bce-sessionid=ok; =empty")
  if (parsed.length !== 1) throw new Error("解析后应只剩 1 条合法 cookie，实际 " + parsed.length)
  if (parsed[0].name !== "bce-sessionid") throw new Error("留下的不是合法项: " + parsed[0].name)
  ok("CR/LF 无出口，非法名丢弃，合法项保留")
} catch (e) { fail("Cookie 头注入防护", e) }

// 节奏与熔断：脚本和真人的区别不在 UA，在「密度、退避、无限重试」。
// 这一组用注入的时钟和 sleep 测，不睡真实时间。
console.log("[U11] 请求节奏：最小间隔 + 抖动，且不睡真实时间")
try {
  let clock = 0
  const slept = []
  const guard = createGuard({
    minIntervalMs: 100,
    jitter: 0,             // 测试里关掉抖动，间隔才是确定的
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms },
  })
  await guard.waitTurn()               // 第一次：clock=0 ≥ nextAt=0，不等
  if (slept.length !== 0) throw new Error("首次请求不该等待，实际等了 " + slept.join(","))
  await guard.waitTurn()               // 第二次：必须等满 100ms
  if (slept.length !== 1 || slept[0] !== 100) throw new Error("第二次应等 100ms，实际 " + JSON.stringify(slept))

  // 抖动开着时，间隔必须落在 [base, base*(1+jitter)) 之内，且不是固定值
  let c2 = 0
  const gaps = []
  const jittered = createGuard({
    minIntervalMs: 1000, jitter: 0.35,
    now: () => c2, sleep: async (ms) => { gaps.push(ms); c2 += ms },
    random: () => 0.5,
  })
  await jittered.waitTurn()
  await jittered.waitTurn()
  await jittered.waitTurn()
  const base = 1000, cap = 1000 * 1.35
  if (!gaps.every((g) => g >= base && g < cap)) throw new Error("间隔越界: " + JSON.stringify(gaps))
  ok("首次零等待、后续按间隔、抖动在上界内")
} catch (e) { fail("请求节奏", e) }

console.log("[U12] 熔断：连续异常就停手，成功清零，到期自动恢复")
try {
  let clock = 1_000_000
  const guard = createGuard({
    minIntervalMs: 0, jitter: 0, tripAfter: 3, cooldownMs: 10 * 60_000,
    now: () => clock, sleep: async () => {},
  })
  guard.note(false); guard.note(false)
  if (guard.isOpen()) throw new Error("两次异常就熔断了，阈值应为 3")
  guard.note(false)
  if (!guard.isOpen()) throw new Error("三次异常后仍未熔断")
  let tripped = null
  try { await guard.waitTurn() } catch (e) { tripped = e }
  if (!tripped?.riskGuard) throw new Error("熔断后 waitTurn 应抛带 riskGuard 标记的错")

  // 成功必须清零，否则一天里零星三次异常就会把 provider 锁死
  clock += 11 * 60_000                  // 越过冷静期
  guard.note(true); guard.note(false); guard.note(false)
  if (guard.isOpen()) throw new Error("成功后计数没清零")
  // 冷静期没到之前不能自己恢复
  guard.note(false); guard.note(false); guard.note(false)
  clock += 60_000
  if (!guard.isOpen()) throw new Error("冷静期未满就恢复了")
  clock += 10 * 60_000
  if (guard.isOpen()) throw new Error("冷静期过后没有自动恢复")
  ok("阈值 3 次熔断、成功清零、冷静期到期恢复")
} catch (e) { fail("熔断", e) }

console.log("[U13] 响应分类：401 是会话问题，不该靠等待解决")
try {
  const r429 = classifyResponse({ status: 429, retryAfterHeader: "120" })
  if (!r429.soft || r429.retryAfterMs !== 120_000) throw new Error("429 + Retry-After 解析错误: " + JSON.stringify(r429))
  const r403 = classifyResponse({ status: 403 })
  if (!r403.soft) throw new Error("403 应计入退避")
  const r502 = classifyResponse({ status: 502 })
  if (!r502.soft) throw new Error("5xx 应计入退避")
  for (const s of [200, 302, 400, 401]) {
    if (classifyResponse({ status: s }).soft) throw new Error(`${s} 不该计入退避（会把一次正常登出锁成故障）`)
  }
  const absurd = classifyResponse({ status: 429, retryAfterHeader: "999999" })
  if (absurd.retryAfterMs > 3600_000) throw new Error("Retry-After 没有封顶，服务端可以让我们停一整天")
  ok("只对 429/403/5xx 退避，401/3xx 不动，Retry-After 有封顶")
} catch (e) { fail("响应分类", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
