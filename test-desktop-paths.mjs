// 第十轮：桌面登录读取的路径矩阵 + auth.json 结构变异容错（全部本地，不联网）
import { DuMatePlugin, _internal } from "./index.mjs"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const { readDesktopLogin, seatIdentity, fallbackAccountId } = _internal
const ok = (n) => console.log(`  PASS ${n}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }
// Temp dir comes from the OS, never from a hardcoded home directory: a
// literal absolute path in a published test file leaks the author's machine
// layout and breaks for anyone whose home directory differs.
const sandbox = join(tmpdir(), "dumate-pathmatrix")
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// 构造一对合法的 auth.json + .cookie-key（真加密 32B key + gcm）
// 密文布局与真实 auth.json 一致：iv(12) + tag(16) + ct —— 注意不是常见的 iv+ct+tag
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
function makeAuthFiles(dir, opts = {}) {
  mkdirSync(dir, { recursive: true })
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const payload = JSON.stringify(opts.cookies ?? [{ name: "bce-sessionid", value: "v", domain: ".baidu.com" }])
  const c = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([c.update(payload, "utf8"), c.final()])
  const tag = c.getAuthTag()
  const enc = Buffer.concat([iv, tag, ct])
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    cookies: enc.toString("base64"),
    ...(opts.authExtra ?? {}),
  }))
  writeFileSync(join(dir, ".cookie-key"), opts.badKey ?? key)
  if (opts.noKey) rmSync(join(dir, ".cookie-key"))
  if (opts.noAuth) rmSync(join(dir, "auth.json"))
}

console.log("[P1] 正常双文件 → 解出 cookies + accountId/name")
try {
  const dir = join(sandbox, "ok")
  makeAuthFiles(dir, { authExtra: { accountProfiles: [{ bceAccountId: "acc-1", displayName: "甲", profileId: "p1" }], activeProfileId: "p1" } })
  process.env.DUMATE_USER_DATA_DIR = dir
  const r = readDesktopLogin()
  if (!r || r.cookies.length !== 1) throw new Error("cookies 未解出")
  if (r.accountId !== "acc-1" || r.name !== "甲") throw new Error("profile 解析: " + JSON.stringify(r).slice(0, 120))
  ok("accountId/name 从 activeProfile 解析")
} catch (e) { fail("正常路径", e) }

console.log("[P2] 无 accountProfiles → 仍能登（name 空）")
try {
  const dir = join(sandbox, "noprofile")
  makeAuthFiles(dir)
  process.env.DUMATE_USER_DATA_DIR = dir
  const r = readDesktopLogin()
  if (!r) throw new Error("应为可读")
  ok("无 profile 时 cookies 仍可用（name 空不致命）")
} catch (e) { fail("无 profile", e) }

console.log("[P3] key 长度不是 32 → null")
try {
  const dir = join(sandbox, "badkey")
  makeAuthFiles(dir, { badKey: randomBytes(16) })
  process.env.DUMATE_USER_DATA_DIR = dir
  const r = readDesktopLogin()
  if (r !== null) throw new Error("应拒绝短 key")
  ok("短 key → null")
} catch (e) { fail("短 key", e) }

console.log("[P4] 无 .cookie-key → null")
try {
  const dir = join(sandbox, "nokey")
  makeAuthFiles(dir, { noKey: true })
  process.env.DUMATE_USER_DATA_DIR = dir
  const r = readDesktopLogin()
  if (r !== null) throw new Error("应拒绝缺 key")
  ok("缺 key → null")
} catch (e) { fail("缺 key", e) }

console.log("[P5] auth.json 损坏（非 JSON / 超大 / 空）→ null")
try {
  const d1 = join(sandbox, "broken1"); makeAuthFiles(d1); writeFileSync(join(d1, "auth.json"), "{not json")
  process.env.DUMATE_USER_DATA_DIR = d1
  if (readDesktopLogin() !== null) throw new Error("坏 JSON 未拒绝")
  const d2 = join(sandbox, "broken2"); makeAuthFiles(d2); writeFileSync(join(d2, "auth.json"), "")
  process.env.DUMATE_USER_DATA_DIR = d2
  if (readDesktopLogin() !== null) throw new Error("空文件未拒绝")
  ok("损坏文件全拒绝")
} catch (e) { fail("损坏文件", e) }

console.log("[P6] 密文被篡改（gcm 认证失败）→ null 不崩")
try {
  const dir = join(sandbox, "tampered")
  makeAuthFiles(dir)
  // 翻转密文区一个字节（ct 区，从 28 开始）
  const fs = await import("node:fs")
  const auth = JSON.parse(fs.readFileSync(join(dir, "auth.json"), "utf8"))
  const raw = Buffer.from(auth.cookies, "base64")
  raw[28] ^= 0xff
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ cookies: raw.toString("base64") }))
  process.env.DUMATE_USER_DATA_DIR = dir
  const r = readDesktopLogin()
  if (r !== null) throw new Error("篡改密文应被 gcm 拒绝")
  ok("gcm 认证失败 → null")
} catch (e) { fail("密文篡改", e) }

console.log("[P7] cookies 解出来是空数组 → null")
try {
  const dir = join(sandbox, "emptycookies")
  makeAuthFiles(dir, { cookies: [] })
  process.env.DUMATE_USER_DATA_DIR = dir
  const r = readDesktopLogin()
  if (r !== null) throw new Error("空 cookie 数组应拒绝")
  ok("空 cookies → null")
} catch (e) { fail("空 cookies", e) }

// 上游 issue #3：两个都没有 bceAccountId 的账号，accountId 都退化成同一个常量，
// magpie 按 accountId 存 seat，于是第二个把第一个顶掉。判据：两个不同登录必须
// 派生两个不同 key，且真实 bceAccountId 一个字都不能变（否则已有 seat 会失联）。
console.log("[P8] 多账号：没有 bceAccountId 时按登录本身派生 seat key")
try {
  const a = seatIdentity({ cookies: [{ name: "bce-sessionid", value: "aaa" }], profileId: "profile-1" })
  const b = seatIdentity({ cookies: [{ name: "bce-sessionid", value: "bbb" }], profileId: "profile-2" })
  if (a.accountId === b.accountId) throw new Error("两个账号派生出同一个 accountId: " + a.accountId)
  if (a.accountId === "百度搭子 DuMate") throw new Error("仍然退化成常量 PROVIDER_NAME")
  if (a.name === b.name) throw new Error("两个账号显示名相同，UI 里分不清: " + a.name)
  // 同一个登录重复推导必须稳定（否则重启 magpie 会凭空多出一个 seat）
  if (fallbackAccountId({ profileId: "profile-1" }) !== fallbackAccountId({ profileId: "profile-1" })) {
    throw new Error("同一登录两次推导结果不同，seat 会在每次重启后重建")
  }
  // 没有 profileId 时退回 cookie 摘要，仍然必须区分得开
  const c = seatIdentity({ cookies: [{ name: "bce-sessionid", value: "ccc" }] })
  const d = seatIdentity({ cookies: [{ name: "bce-sessionid", value: "ddd" }] })
  if (c.accountId === d.accountId) throw new Error("无 profileId 时退化成同一个 key")
  ok("两账号两个 key、同名不撞、推导可重复")
} catch (e) { fail("多账号 seat key", e) }

console.log("[P9] 真实 bceAccountId 原样透传（不让已有 seat 失联）")
try {
  const real = seatIdentity({ accountId: "bce-account-0001", name: "某账号", cookies: [{ name: "a", value: "b" }] })
  if (real.accountId !== "bce-account-0001") throw new Error("bceAccountId 被改写: " + real.accountId)
  if (real.name !== "某账号") throw new Error("displayName 被改写: " + real.name)
  const bare = seatIdentity({})
  if (bare.accountId !== "百度搭子 DuMate") throw new Error("空登录不应伪造 id: " + bare.accountId)
  ok("真实 id 与显示名不动，空登录仍保持原常量")
} catch (e) { fail("seat key 兼容性", e) }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
