// 第十五轮：把八个已修 bug 全部做成"回归哨兵"——每个 bug 一个专杀用例，
// 确保未来改动不会让任何已修 bug 复活。全部离线 mock，不耗积分。
import { DuMatePlugin, _internal } from "./index.mjs"

// 本套件断言的是行为，不是节奏：关掉 guard 的最小间隔，否则每次被测调用
// 都要多等 800ms（runner 会给离线套件设 0，单独跑本文件时靠这一行）。
process.env.DUMATE_MIN_INTERVAL_MS = "0"

const { parseCookieString, shouldFollowDesktop } = _internal
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }
const hooks = await DuMatePlugin({})
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
const realFetch = globalThis.fetch

console.log("[G1] bug#1 哨兵：document.cookie 串（无 bce-sessionid）必须被拒")
try {
  const docCookie = "BAIDUID=abc; PSTM=1; BIDUPSID=2" // 无 bce-sessionid
  const flow = await hooks.auth.methods[1].authorize()
  const r = await flow.callback(docCookie)
  if (r.type !== "failed" || !/bce-sessionid/.test(r.error)) throw new Error("拒绝对话失效: " + JSON.stringify(r).slice(0, 100))
  ok("浏览器登录仍强制 bce-sessionid")
} catch (e) { fail("bug#1", e) }

console.log("[G2] bug#2 哨兵：config hook 必须是函数且注册出模型")
try {
  if (typeof hooks.config !== "function") throw new Error("config 退化了")
  const cfg = {}
  await hooks.config(cfg)
  if (Object.keys(cfg.provider.dumate.models).length < 2) throw new Error("模型数不足")
  ok("async config + 2 模型在位")
} catch (e) { fail("bug#2", e) }

console.log("[G3] bug#3 哨兵：desktop seat 的 refresh 会读本机 auth.json（不抛错）")
try {
  const r = await hooks.auth.refresh({ type: "oauth", source: "desktop", cookies: [{ name: "x", value: "1", domain: ".baidu.com" }] })
  // 本机 auth.json 存在且 header 不同 → 返回新 auth；不存在/相同 → undefined；都合法，但不能抛
  if (r !== undefined && !r.cookies) throw new Error("refresh 返回异常形态")
  ok(`refresh 正常（${r === undefined ? "本机未变/不可用" : "跟随了 " + r.cookies.length + " 条新 cookie"}）`)
} catch (e) { fail("bug#3", e) }

console.log("[G4] bug#4 哨兵：签到积分来自 delta 而非硬编码")
try {
  let g4state = 0
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("loginBonusInfo")) {
      // 用非常规数额（1234→1337，delta=103）确保不是 500 硬编码
      g4state++
      return g4state === 1
        ? new Response(JSON.stringify({ code: 0, result: { hasIssued: false, totalPoints: "1234", totalTimes: 1 } }), { status: 200 })
        : new Response(JSON.stringify({ code: 0, result: { hasIssued: true, totalPoints: "1337", totalTimes: 2 } }), { status: 200 })
    }
    if (url.includes("loginBonus")) return new Response(JSON.stringify({ code: 0, result: true }), { status: 200 })
    return realFetch(input)
  }
  const seat = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "g4", domain: ".baidu.com" }], source: "manual" }
  const c = await hooks.auth.checkin(async () => seat)
  if (c.credit !== 103) throw new Error("credit=" + c.credit + " 应为 103（delta）")
  ok("delta=103 正确（非硬编码 500）")
} catch (e) { fail("bug#4", e) }

console.log("[G5] bug#7 哨兵：HTML 登录页 → 401 expired（非 502 接口错误）")
try {
  const seat = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "g5-fresh-" + Date.now(), domain: ".baidu.com" }], source: "manual" }
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("token/get")) return new Response("<!DOCTYPE html><html>百度智能云-登录</html>", { status: 200 })
    return new Response("{}", { status: 200 })
  }
  const l = await hooks.auth.loader(async () => seat)
  const r = await l.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "model-text", messages: [{ role: "user", content: "x" }] }) })
  if (r.status !== 401 || r.headers.get("x-magpie-sign-in") !== "expired") throw new Error(`HTTP ${r.status}/${r.headers.get("x-magpie-sign-in")}`)
  ok("登录页正确映射 401/expired")
} catch (e) { fail("bug#7", e) }

console.log("[G6] bug#9 哨兵：expireDate=null 不产生 1970 时间戳")
try {
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("quota_overview")) {
      return new Response(JSON.stringify({ code: 0, result: { totalPoints: "100", usedPoints: "1", subscription: [{ status: "active", expireDate: null }] } }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, result: { totalTimes: 0 } }), { status: 200 })
  }
  const seat = { type: "oauth", cookies: [{ name: "bce-sessionid", value: "g6", domain: ".baidu.com" }], source: "manual" }
  const u = await hooks.auth.usage(async () => seat)
  if (u.windows[0].runsOutAt !== undefined) throw new Error("仍产生 runsOutAt: " + u.windows[0].runsOutAt)
  ok("null expireDate 无 runsOut")
} catch (e) { fail("bug#9", e) }

// 实测这台机器上 magpie 每 260 秒轮询一次 usage，最近两次只差 63 秒；每次轮询
// 要打两发 console 请求，而 loginBonusInfo 一天只变一次。夜里没人用的时候
// 「每 4 分钟准点两发」本身就是作息表，能省就省。
console.log("[G10] usage 降频：30 秒内重复轮询不再打 console")
try {
  let quotaCalls = 0, bonusCalls = 0
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("quota_overview")) {
      quotaCalls++
      return new Response(JSON.stringify({ code: 0, success: true, result: { totalPoints: "100", usedPoints: "1" } }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    if (url.includes("loginBonusInfo")) {
      bonusCalls++
      return new Response(JSON.stringify({ code: 0, success: true, result: { hasIssued: true, totalTimes: 3 } }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response("{}", { status: 200 })
  }
  const seat = { type: "oauth", source: "manual", cookies: [{ name: "bce-sessionid", value: "CACHE-SEAT-1", domain: ".baidu.com" }] }
  const u1 = await hooks.auth.usage(async () => seat)
  const u2 = await hooks.auth.usage(async () => seat)
  // 余额每次都实时问（它同时是会话探针），签到信息只问一次
  if (quotaCalls !== 2) throw new Error(`余额应每次实时，实际 quota=${quotaCalls}`)
  if (bonusCalls !== 1) throw new Error(`签到信息应被缓存，实际 bonus=${bonusCalls}`)
  if (u1.balance !== u2.balance) throw new Error("两次余额不一致")
  // 另一个 seat 必须自己问一次（缓存按 seat 摘要分组，不能串号）
  await hooks.auth.usage(async () => ({ ...seat, cookies: [{ name: "bce-sessionid", value: "CACHE-SEAT-2", domain: ".baidu.com" }] }))
  if (bonusCalls !== 2) throw new Error("第二个账号复用了别人的缓存: bonus=" + bonusCalls)
  if (quotaCalls !== 3) throw new Error("第二个账号余额没有实时问: quota=" + quotaCalls)
  ok("余额实时、签到信息按 seat 缓存且不串号")
} catch (e) { fail("usage 降频", e) }

console.log("[G11] 桌面端换号：refresh 不许静默把新账号顶到旧 seat 上")
try {
  if (shouldFollowDesktop({ accountId: "acc-A" }, { accountId: "acc-A", cookies: [] }) !== true) {
    throw new Error("同账号不该被拦")
  }
  if (shouldFollowDesktop({ accountId: "acc-A" }, { accountId: "acc-B", cookies: [] }) !== false) {
    throw new Error("换号仍被跟随：会拿旧 seat 的 key 装新账号的凭据")
  }
  if (shouldFollowDesktop({ accountId: "acc-A" }, null) !== false) throw new Error("桌面端没了还跟随")
  // 任一侧没有 accountId 时保持旧行为，不能因为字段缺失就拒绝刷新
  if (shouldFollowDesktop({}, { accountId: "acc-B" }) !== true) throw new Error("缺字段时被误拦")
  if (shouldFollowDesktop({ accountId: "acc-A" }, {}) !== true) throw new Error("桌面端缺 accountId 时被误拦")
  ok("同号跟随、异号拒绝、缺字段放行")
} catch (e) { fail("换号闸门", e) }

globalThis.fetch = realFetch
console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
