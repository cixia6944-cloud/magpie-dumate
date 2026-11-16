// OpenCode & Magpie provider plugin for Baidu DuMate (百度搭子 / qianfan-desktop).
//
// DuMate (Baidu) signs in through login.bce.baidu.com (Baidu account web OAuth);
// the desktop app persists the session cookies AES-256-GCM-encrypted in
// <userData>/auth.json with the key in <userData>/.cookie-key. This plugin
// reuses that login (read-only) or accepts pasted cookies from a manual browser
// sign-in. Cookies are exchanged per-session for a gateway token via
// /api/dumate/app/token/get, then chats go straight to
// https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions (OpenAI-compatible)
// and burn the account's personal points. Check-in amounts follow the server.
//
// Login methods:
//   1. desktop  — reuse the local DuMate app login (read-only, recommended)
//   2. browser  — open login.bce.baidu.com in the default browser, log in, then
//                 copy the `Cookie` request header of any request from DevTools
//                 → Network (httpOnly cookies are required, so document.cookie
//                 will NOT work); no DuMate install needed
//   3. manual   — paste a "name=value; ..." cookie string directly
//
// 0.3.0: cross-platform desktop paths, the real per-account model catalog and
// V4.1 reasoning controls were fixed after RanceLee (公众号 HelloRanceLee)
// reported the macOS sign-in failure and proposed the solution on 2026-11-13.
// See README.md -> 致谢.

import { createDecipheriv, createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createGuard, classifyResponse } from "./guard.mjs"
import { desktopUserDataDir } from "./paths.mjs"
import { loadModels } from "./models.mjs"
import { normalizeReasoningBody } from "./reasoning.mjs"
import { withStreamUsage, bodyBreakdown, formatBreakdown } from "./usage-meter.mjs"

const PROVIDER_ID = "dumate"
const PROVIDER_NAME = "百度搭子 DuMate"

const CONSOLE_BASE = "https://console.bce.baidu.com"
const LOGIN_URL = "https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F"
const GATEWAY_BASE = "https://dumate-svc.baidu.com/gateway/apis/v1"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.82 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36"

const TOKEN_TTL_MS = 60 * 60 * 1000 // refresh token hourly; server gives ~14h

// Fallback model catalog (gateway has no /models endpoint). model-text is the
// auto-routing alias the desktop app itself uses; the gateway resolves it to
// live upstreams (observed 2026-10-26: responses always echo "model-text" —
// the router hides upstream identity; id prefix is "gd-").
const FALLBACK_MODELS = [
  { id: "model-text", name: "DuMate Auto (智能路由)", context: 192_000, output: 128_000, reasoning: true },
  { id: "dm-auto-model/text.L0", name: "DuMate Auto L0", context: 192_000, output: 128_000, reasoning: true },
]

// ---- DuMate desktop login files (read-only) --------------------------------
// desktopUserDataDir() now lives in ./paths.mjs: macOS uses ~/Library/Application
// Support, Linux uses $XDG_CONFIG_HOME, Windows keeps %APPDATA%. A Windows
// install that redirects userData through a junction is followed by the OS.
// DUMATE_USER_DATA_DIR still overrides every platform default.

// The provider's picture, as magpie reads it: a data:image URI on the auth hook.
// Preference order, first hit wins:
//   1. icon.png next to this file — the app's own artwork, shipped with the plugin
//   2. the installed DuMate app's icon set — same picture, read in place
//   3. icon.svg next to this file — vector stand-in if neither PNG is there
//   4. '' — magpie then draws its generic tile
// Read-only throughout and every read is guarded, so a missing or unreadable
// icon degrades down the list instead of failing the plugin.
const MAX_ICON_URI = 1024 * 1024 // magpie's cap on the icon URI

// base64 inflates ~4/3, so measure the encoded string, not the file size.
function pngDataUri(buf) {
  if (!buf?.length) return ""
  // A file that isn't really a PNG would render as a broken image, so check
  // the signature before advertising it as image/png.
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return ""
  const encoded = buf.toString("base64")
  if (encoded.length + 32 > MAX_ICON_URI) return ""
  return `data:image/png;base64,${encoded}`
}

function iconFromPluginDir() {
  try {
    return pngDataUri(readFileSync(new URL("./icon.png", import.meta.url)))
  } catch {
    return ""
  }
}

function iconFromDesktopApp() {
  try {
    const installJson = JSON.parse(readFileSync(join(desktopUserDataDir(), "install.json"), "utf8"))
    const installDir = String(installJson?.installDir ?? "").trim()
    if (!installDir) return ""
    // magpie renders icons at 20-40px, so 256 is already past the point where a
    // bigger source helps; it just triples the base64 cost. Bigger sizes are the
    // last resort only (i.e. when 256/128 are missing from the install).
    for (const name of ["256x256.png", "128x128.png", "512x512.png"]) {
      try {
        const uri = pngDataUri(readFileSync(join(installDir, "program", "resources", "resources", "icons", name)))
        if (uri) return uri
      } catch {
        // try the next size
      }
    }
  } catch {
    // no desktop app installed — not an error
  }
  return ""
}

function iconFromBundle() {
  try {
    const svg = readFileSync(new URL("./icon.svg", import.meta.url), "utf8")
    if (!svg.trim()) return ""
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
  } catch {
    return ""
  }
}

// Evaluated once at load, in the documented preference order.
const pluginIcon = iconFromPluginDir() || iconFromDesktopApp() || iconFromBundle()

function readDesktopLogin() {
  try {
    const dir = desktopUserDataDir()
    const authPath = join(dir, "auth.json")
    const keyPath = join(dir, ".cookie-key")
    const st = statSync(authPath)
    if (!st.isFile() || st.size <= 0 || st.size > 1024 * 1024) return null
    const auth = JSON.parse(readFileSync(authPath, "utf8"))
    const cookiesField = auth?.cookies
    if (typeof cookiesField !== "string" || !cookiesField) return null
    const key = readFileSync(keyPath)
    if (key.length !== 32) return null
    const buf = Buffer.from(cookiesField, "base64")
    // Cipher layout (verified against a real auth.json): iv(12) + tag(16) + ct
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8")
    const arr = JSON.parse(plain)
    if (!Array.isArray(arr) || !arr.length) return null
    const profile = Array.isArray(auth.accountProfiles) && auth.activeProfileId
      ? auth.accountProfiles.find((p) => p?.profileId === auth.activeProfileId)
      : null
    return {
      cookies: arr,
      accountId: String(profile?.bceAccountId ?? auth?.accountProfiles?.[0]?.bceAccountId ?? ""),
      // profileId is the app's own per-seat identifier. It is not shown anywhere,
      // but it lets fallbackAccountId() tell two seats apart when the account has
      // no bceAccountId.
      profileId: String(profile?.profileId ?? ""),
      name: String(profile?.displayName ?? auth?.accountProfiles?.[0]?.displayName ?? ""),
      source: "desktop",
    }
  } catch {
    return null
  }
}

// ---- Cookie helpers (replicates DuMate's utils/cookie.js exactly) ----------

// Cookie names and values reach us from an encrypted app file and from the
// clipboard. A value carrying CR/LF would split our own header, and a name that
// contains a space or "=" would rewrite the rest of it — both are shapes of
// pasted junk, never of a real cookie. Nothing outside RFC 6265's token set is
// allowed through.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/

// Strip the quote wrapping and any control character; keep everything else so a
// real (occasionally quoted) Baidu value survives byte for byte.
const cookieValue = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/^["']+|["']+$/g, "")

const usableCookies = (list) => (Array.isArray(list) ? list : []).filter((c) => COOKIE_NAME.test(String(c?.name ?? "")))

// Serialize cookies for a hostname the way DuMate does: domain-filter, strip
// quotes, re-quote values containing : | ; = or spaces. POST endpoints reject
// the request ("登录凭证已过期") when the header is built any other way.
function buildCookieHeader(cookies, hostname) {
  const matched = usableCookies(cookies).filter((c) => {
    if (!c.domain) return true
    const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain
    return hostname === domain || hostname.endsWith("." + domain)
  })
  return matched
    .map((c) => {
      let val = cookieValue(c.value)
      if (/[:|;=\s]/.test(val)) val = `"${val}"`
      return `${c.name}=${val}`
    })
    .join("; ")
}

// csrftoken comes from the bce-user-info cookie value for the target host.
function extractCsrfToken(cookies, hostname) {
  const hit = usableCookies(cookies).find((c) => {
    if (c.name !== "bce-user-info") return false
    if (!hostname || !c.domain) return false
    const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain
    return hostname === domain || hostname.endsWith("." + domain)
  })
  return hit ? cookieValue(hit.value) : ""
}

// Parse a pasted "name=value; name2=value2" string into DuMate cookie objects.
// Pasted strings carry no domain info; ".baidu.com" matches every host we call
// (console.bce.baidu.com is a subdomain), which is exactly what we need.
function parseCookieString(raw) {
  const out = []
  for (const part of String(raw ?? "").split(/;\s*/)) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    if (!COOKIE_NAME.test(name)) continue
    let value = cookieValue(part.slice(idx + 1).trim())
    out.push({ name, value, domain: ".baidu.com" })
  }
  return out
}

// A seat's identity inside magpie is its accountId. Every login path used to
// fall back to the constant PROVIDER_NAME when the account had no bceAccountId,
// so a second account got the same key as the first and silently replaced it
// (upstream issue #3). Derive a stable per-login id instead: the app's profileId
// when it provides one, otherwise a digest of the cookie set itself. Real
// bceAccountId values still pass through untouched, so seats that already have a
// proper key keep exactly the same one.
function fallbackAccountId(login) {
  const cookies = usableCookies(login?.cookies)
  const seed = String(login?.profileId || "") ||
    cookies.map((c) => `${c.name}=${cookieValue(c.value)}`).join("; ")
  if (!seed) return PROVIDER_NAME
  return `dumate-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`
}

// accountId plus a name that is actually distinguishable in magpie's account
// list — two seats both called "百度搭子 DuMate" is what made the overwrite look
// like a mystery.
function seatIdentity(login) {
  const accountId = String(login?.accountId || "") || fallbackAccountId(login)
  const name = String(login?.name || "") ||
    (accountId === PROVIDER_NAME ? PROVIDER_NAME : `DuMate ${accountId.slice(-6)}`)
  return { accountId, name }
}

// BDUSS/STOKEN/bce-sessionid are httpOnly, so document.cookie can never carry
// them — and matrix testing showed the console API needs at least bce-sessionid
// alongside the visible cookies. The browser method therefore asks for the
// DevTools Network "Cookie" request header (or the Application panel export),
// which includes httpOnly entries.
const REQUIRED_COOKIES = ["bce-sessionid"]

// ---- Text safety for user-facing messages ----------------------------------

// Everything a hook returns as `message` lands on the account card, in magpie's
// log and on the terminal. A remote answer is not trusted with control
// characters: a newline forges a log line, an escape sequence drives the
// terminal, and a bidi override can turn a name inside out. Visible characters
// are kept up to a length that fits a card, counting code points so a surrogate
// pair is never cut in half.
const cardText = (value, max = 200) => {
  const cleaned = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .trim()
  const points = Array.from(cleaned)
  return points.length > max ? points.slice(0, max).join("") : cleaned
}

// checkin runs under a shared 2-minute budget across every provider's accounts,
// asked one account at a time; a slow account must not eat the others' share.
// A hook cut short answers failed, which the host retries in half an hour.
const CHECKIN_BUDGET_MS = 25 * 1000

// ---- Console API (GET works with plain cookie header) ----------------------

// Baidu's console redirects expired sessions to an HTML login page with HTTP
// 200 (fetch follows the 302), so an HTML body means "sign-in expired", not an
// API error — map it to signIn=expired so magpie prompts a re-login.
function consoleError(payload, fallback) {
  const msg = typeof payload?.message === "string" ? payload.message : JSON.stringify(payload?.message ?? "")
  const err = new Error(`DuMate 接口错误: ${msg || fallback}`)
  if (/登录凭证|重新登录|login/i.test(msg)) err.signIn = "expired"
  return err
}

function htmlSignInError() {
  const err = new Error("DuMate 登录态已失效（接口返回登录页），请重新登录")
  err.signIn = "expired"
  return err
}

// One guard for the whole process: the console endpoints are what a burst would
// look like, and the state has to be shared across accounts to be worth anything.
const riskGuard = createGuard()

// 429/403/5xx and an explicit Retry-After are the shapes worth backing off from.
// 401 and the HTML login page are a session problem, not a pacing problem — if
// they tripped the breaker, one ordinary sign-out would lock the provider for
// 15 minutes and the user would read it as "插件坏了".
function reportResult(status, headers) {
  const { soft, retryAfterMs } = classifyResponse({
    status,
    retryAfterHeader: headers?.get?.("retry-after"),
  })
  if (soft) riskGuard.note(false, { retryAfterMs })
  return soft
}

async function consoleGet(path, cookieStr) {
  await riskGuard.waitTurn()
  const res = await fetch(`${CONSOLE_BASE}${path}`, {
    headers: {
      Cookie: cookieStr,
      "User-Agent": UA,
      Accept: "application/json",
      Referer: `${CONSOLE_BASE}/`,
    },
    // Never follow a redirect with cookies attached. Keep the 3xx response
    // instead of rejecting it: an expired session is usually a 302 to the
    // login page, and a hard redirect error would wrongly degrade the
    // signIn=expired signal into a generic 502.
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  })
  const soft = reportResult(res.status, res.headers)
  if (res.status >= 300 && res.status < 400) throw htmlSignInError()
  const text = await res.text()
  let payload = null
  try { payload = JSON.parse(text) } catch {}
  if (payload === null || typeof payload !== "object") {
    // HTML login page (session expired) or other non-JSON body.
    if (/登录|login|<!DOCTYPE|<html/i.test(text.slice(0, 500))) throw htmlSignInError()
    throw new Error(`DuMate console HTTP ${res.status} 非 JSON 响应`)
  }
  if (!res.ok) throw new Error(`DuMate console HTTP ${res.status}`)
  if (payload?.code !== 0 || payload?.success === false) throw consoleError(payload, `code=${payload?.code}`)
  // A clean answer resets the streak: the breaker counts trouble, not traffic.
  if (!soft) riskGuard.note(true)
  return payload?.result
}

// POST needs domain-filtered cookies + csrftoken header + XHR headers.
async function consolePost(path, body, cookies) {
  const cookieStr = buildCookieHeader(cookies, "console.bce.baidu.com")
  const csrftoken = extractCsrfToken(cookies, "console.bce.baidu.com")
  const res = await fetch(`${CONSOLE_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: CONSOLE_BASE,
      Referer: `${CONSOLE_BASE}/`,
      Cookie: cookieStr,
      csrftoken,
      "User-Agent": UA,
      Accept: "application/json",
    },
    body: JSON.stringify(body ?? {}),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  })
  const soft = reportResult(res.status, res.headers)
  if (res.status >= 300 && res.status < 400) throw htmlSignInError()
  const text = await res.text()
  let payload = null
  try { payload = JSON.parse(text) } catch {}
  if (payload === null || typeof payload !== "object") {
    if (/登录|login|<!DOCTYPE|<html/i.test(text.slice(0, 500))) throw htmlSignInError()
    throw new Error(`DuMate console HTTP ${res.status} 非 JSON 响应`)
  }
  if (!res.ok) throw new Error(`DuMate console HTTP ${res.status}`)
  if (payload?.code !== 0 || payload?.success === false) throw consoleError(payload, `code=${payload?.code}`)
  // A clean answer resets the streak: the breaker counts trouble, not traffic.
  if (!soft) riskGuard.note(true)
  return payload?.result
}

// ---- Gateway token (single-flight cache) ------------------------------------

const tokenCache = new Map() // cookieHeader -> { token, expiresAt, pending }

// One entry per cookie set, and the key is a full credential — so the map must
// not grow without bound when seats are added and removed over and over. Keep
// the newest few and let the dropped ones re-derive on next use (one extra round
// trip, never a wrong token).
const TOKEN_CACHE_MAX = 16
function rememberToken(header, entry) {
  tokenCache.set(header, entry)
  if (tokenCache.size <= TOKEN_CACHE_MAX) return
  for (const key of tokenCache.keys()) {
    if (tokenCache.size <= TOKEN_CACHE_MAX) break
    // In-flight single-flight markers own their own lifecycle in .finally().
    if (key.endsWith("\u0000pending")) continue
    tokenCache.delete(key)
  }
}

// ---- Usage snapshot cache ---------------------------------------------------
//
// magpie 轮询 usage 的节奏是分钟级（实测这台机器上中位间隔 260 秒，两次相邻轮询
// 最近只差 63 秒）。每次 usage() 要打两发 console 请求：quota_overview 和
// loginBonusInfo。后者一天只变一次，前者在 30 秒内重复问也是同一个数。
//
// 这些请求不花积分，但每一发都是「行为面」：夜里没人用的时候每 4 分钟准点
// 两发 console 请求，本身就是一张作息表。签到信息一天只变一次，缓存 10 分钟
// 没有代价；余额不缓存——它同时是「会话还活着吗」的探针。
//
// key 用 cookie 头的摘要而不是头本身：缓存表不该额外多存一份凭据。
// Only the daily check-in snapshot is cached. Measured on this machine: magpie
// polls usage every ~260s and each poll asks for both the balance (above) and
// this one; loginBonusInfo changes once a day, so a 10-minute window turns most
// of those asks into no-ops without ever affecting a decision that matters.
const USAGE_TTLS = { bonus: 10 * 60_000 }
const USAGE_CACHE_MAX = 8
const usageCache = new Map() // "<kind>\0<digest>" -> { at, value }

const seatDigest = (header) => createHash("sha256").update(String(header ?? "")).digest("hex").slice(0, 16)

async function cachedConsoleGet(kind, path, header) {
  const key = `${kind}\u0000${seatDigest(header)}`
  const ttl = USAGE_TTLS[kind] ?? 0
  const hit = usageCache.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.value
  const value = await consoleGet(path, header)
  usageCache.set(key, { at: Date.now(), value })
  if (usageCache.size > USAGE_CACHE_MAX) {
    for (const k of usageCache.keys()) {
      if (usageCache.size <= USAGE_CACHE_MAX) break
      usageCache.delete(k)
    }
  }
  return value
}

// 桌面端换了账号时，refresh 绝不能把新账号的 Cookie 悄悄顶到旧 seat 上：
// seat key 不变，magpie 会以为「还是那个号」，而真实凭据已经换人。
// 返回 false 让它走原来的 401 → signIn=expired 路径，由用户显式重新登录。
// 任一侧没有 accountId 时保持旧行为（不阻塞正常刷新）。
export function shouldFollowDesktop(auth, desktop) {
  if (!desktop) return false
  const mine = String(auth?.accountId ?? "")
  const theirs = String(desktop?.accountId ?? "")
  if (!mine || !theirs) return true
  return mine === theirs
}

async function fetchGatewayToken(cookieHeader) {
  const cached = tokenCache.get(cookieHeader)
  if (cached && Date.now() < cached.expiresAt - 5 * 60_000) return cached
  let pending = tokenCache.get(cookieHeader + "\u0000pending")
  if (!pending) {
    pending = (async () => {
      const result = await consoleGet("/api/dumate/app/token/get", cookieHeader)
      const token = String(result?.token ?? "")
      if (!token) throw new Error("DuMate 未返回 gateway token")
      const expiresAt = result?.expired_at ? Date.parse(result.expired_at) : Date.now() + TOKEN_TTL_MS
      return { token, expiresAt: Number.isFinite(expiresAt) && expiresAt > Date.now() ? expiresAt : Date.now() + TOKEN_TTL_MS }
    })().finally(() => tokenCache.delete(cookieHeader + "\u0000pending"))
    tokenCache.set(cookieHeader + "\u0000pending", pending)
  }
  const next = await pending
  rememberToken(cookieHeader, next)
  return next
}

// ---- Plugin ----------------------------------------------------------------

export const DuMatePlugin = async (input = {}) => {
  const consoleCookies = async (auth) => {
    if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) throw signInError(auth)
    return auth.cookies
  }
  const signInError = (auth) => {
    const err = new Error(
      auth?.source === "desktop"
        ? "DuMate 桌面端登录态已失效，请打开百度搭子重新登录后在此重新登录"
        : "DuMate 登录态已失效，请重新登录",
    )
    err.signIn = "expired"
    return err
  }

  const cookieHeaderOf = (cookies) => usableCookies(cookies).map((c) => `${c.name}=${cookieValue(c.value)}`).join("; ")

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: GATEWAY_BASE,
        ...was,
        models: {
          ...Object.fromEntries(
            FALLBACK_MODELS.map((m) => [
              m.id,
              {
                name: m.name,
                limit: { context: m.context, output: m.output },
                tool_call: true,
                reasoning: !!m.reasoning,
                attachment: false,
                modalities: { input: ["text"], output: ["text"] },
              },
            ]),
          ),
          // Real catalog from the active DuMate account (metadata only).
          // Falls back to the last snapshot / shipped reference when the
          // desktop config is gone. User-added models stay last and win.
          ...loadModels({ stateDir: input.directory }),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        return provider.models
      },
    },

    auth: {
      provider: PROVIDER_ID,
      icon: pluginIcon,

      async refresh(auth) {
        // Cookies have no refresh flow. For desktop-source seats, follow the
        // app: if it re-logged-in, pick up its newer cookies transparently
        // (raccoon-style) instead of forcing a magpie re-login.
        if (auth?.type !== "oauth" || auth.source !== "desktop") return undefined
        const d = readDesktopLogin()
        if (!d) return undefined
        // The app may now be signed in to a different account. Following it
        // would keep this seat key but swap the credentials underneath it, so
        // magpie would show the old account's name over the new account's
        // cookies. Refuse; the stale cookies then fail as a normal expired
        // sign-in and the user re-logs in deliberately.
        if (!shouldFollowDesktop(auth, d)) return undefined
        const oldHeader = cookieHeaderOf(auth.cookies)
        const newHeader = cookieHeaderOf(d.cookies)
        if (newHeader === oldHeader) return undefined
        const seat = seatIdentity({ ...d, accountId: d.accountId || auth.accountId, name: d.name || auth.name })
        return {
          access: "cookie:" + newHeader,
          refresh: "",
          expires: 0,
          source: "desktop",
          accountId: seat.accountId,
          name: seat.name,
          cookies: d.cookies,
        }
      },

      async loader(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return {
            baseURL: GATEWAY_BASE,
            apiKey: "dumate",
            async fetch() {
              return new Response(
                JSON.stringify({ error: { message: `DuMate 登录态读取失败: ${e?.message ?? e}`, type: "api_error" } }),
                { status: 502, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" } },
              )
            },
          }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return {
            baseURL: GATEWAY_BASE,
            apiKey: "dumate",
            async fetch() {
              return new Response(
                JSON.stringify({ error: { message: "DuMate 未登录，请先在 Magpie 登录", type: "authentication_error" } }),
                { status: 401, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" } },
              )
            },
          }
        }
        const cookies = auth.cookies
        return {
          baseURL: GATEWAY_BASE,
          apiKey: "dumate",
          async fetch(input, init = {}) {
            const req = input instanceof Request ? input : null
            // Only the official chat endpoint may receive the gateway token.
            // A redirect or a rewritten URL must never leak it elsewhere.
            let target
            try { target = new URL(req ? req.url : String(input)) } catch {
              // Unparseable URL - rejected below.
            }
            const gateway = new URL(GATEWAY_BASE)
            if (!target || target.origin !== gateway.origin ||
                target.pathname !== gateway.pathname + "/chat/completions" ||
                target.username || target.password) {
              return new Response(
                JSON.stringify({ error: { message: "DuMate 仅允许请求官方聊天接口", type: "invalid_request_error" } }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              )
            }
            // Breaker open: say so now, in the vocabulary the caller understands
            // (429), instead of queueing work that would all hit the same wall.
            if (riskGuard.isOpen()) {
              const left = Math.ceil((riskGuard.status().openUntil - Date.now()) / 60_000)
              return new Response(
                JSON.stringify({
                  error: {
                    message: `DuMate 暂缓调用，约 ${left} 分钟后自动恢复（连续异常后退避，避免继续重试触发风控）`,
                    type: "rate_limit_error",
                  },
                }),
                { status: 429, headers: { "Content-Type": "application/json" } },
              )
            }
            let bodyText = init?.body
            if (bodyText === undefined && req) bodyText = await req.clone().text()
            bodyText = normalizeReasoningBody(bodyText)
            // Ask for usage on streaming calls so magpie can see tokens and
            // cache hits at all — 297/297 of this provider's records were 0.
            bodyText = withStreamUsage(bodyText)
            // 实测上行 p50 557KB、p90 1.9MB，而网关不缓存前缀也不吃 gzip，
            // 所以体积就是全价。要看钱花在哪，设 DUMATE_SIZE_LOG=1 打一行分解；
            // 默认不输出，避免每次请求都往日志里写东西。
            if (process.env.DUMATE_SIZE_LOG === "1") {
              const bd = bodyBreakdown(bodyText)
              if (bd) console.error(`[dumate] 上行体积 ${formatBreakdown(bd)}`)
            }
            let cred
            try {
              cred = await fetchGatewayToken(cookieHeaderOf(cookies))
            } catch (e) {
              const expired = e?.signIn === "expired"
              return new Response(
                JSON.stringify({ error: { message: e?.message ?? String(e), type: expired ? "authentication_error" : "api_error" } }),
                { status: expired ? 401 : 502, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": expired ? "expired" : "kept" } },
              )
            }
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.set("Authorization", `Bearer ${cred.token}`)
            headers.set("Content-Type", "application/json")
            headers.delete("x-api-key")
            headers.delete("content-length")
            const res = await fetch(req ? req.url : input, {
              ...init,
              method: init?.method ?? req?.method ?? "POST",
              headers,
              body: bodyText,
              // Same rule as the console calls: never follow a redirect with
              // the gateway token, but keep the 3xx so it can be reported as
              // an expired session instead of an unhandled network error.
              redirect: "manual",
            })
            // A 429/403 from the gateway is the one signal worth acting on
            // immediately: report it to the breaker so the next few calls fail
            // fast instead of piling onto whatever limit we just hit.
            reportResult(res.status, res.headers)
            if ((res.status >= 300 && res.status < 400) || res.status === 401) {
              tokenCache.delete(cookieHeaderOf(cookies))
              return new Response(
                JSON.stringify({ error: { message: "DuMate gateway token 已失效并清除缓存，请重试或重新登录", type: "authentication_error" } }),
                { status: 401, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" } },
              )
            }
            return res
          },
        }
      },

      async usage(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return { error: cardText(e?.message) || "登录态读取失败", signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return { error: "没有登录信息，请先在 Magpie 登录", signIn: "kept" }
        }
        try {
          const cookies = await consoleCookies(auth)
          const header = cookieHeaderOf(cookies)
          let overviewError = null
          const [overview, info] = await Promise.all([
            // Deliberately not cached: this is also the probe that tells us the
            // session is still alive. A 30s cache would let a dead sign-in keep
            // reporting a healthy balance, and the user would see a stale number
            // right up until a chat failed.
            consoleGet(
              "/api/dumate/points/quota_overview?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true",
              header,
            ).catch((e) => {
              overviewError = e
              return null
            }),
            cachedConsoleGet("bonus", "/api/dumate/points/loginBonusInfo", header).catch(() => null),
          ])
          // A dead session is a sign-in problem, not "the quota endpoint is
          // down": rethrow so the signIn=expired marker survives and magpie
          // asks for a re-login instead of retrying a session that cannot work.
          if (!overview) throw overviewError ?? new Error("quota_overview 不可用")
          const total = parseFloat(overview.totalPoints) || 0
          const used = parseFloat(overview.usedPoints) || 0
          const packs = [...(overview.subscription ?? []), ...(overview.incremental ?? [])]
          let soonest = null
          for (const p of packs) {
            if (p?.status !== "active") continue
            // expireDate can be null on never-expiring packs — Number(null)*1000
            // would yield 1970, so guard it.
            const expMs = p.expireDate == null ? NaN : Number(p.expireDate) * 1000
            if (!Number.isFinite(expMs) || expMs <= 0) continue
            if (!soonest || expMs < soonest.ms) soonest = { ms: expMs, points: parseFloat(p.totalPoints) || 0 }
          }
          return {
            plan: info && info.totalTimes ? `已签到 ${info.totalTimes} 天` : "Free",
            balance: `${(total - used).toFixed(2)} 积分`,
            windows: [
              {
                name: "Points",
                used: total > 0 ? (100 * used) / total : 0,
                display: `${used.toFixed(2)} / ${total.toFixed(2)}`,
                amount: used,
                limit: total,
                unit: "points",
                ...(soonest
                  ? { runsOutAt: new Date(soonest.ms).toISOString(), runsOut: Math.min(total - used, soonest.points) }
                  : {}),
              },
            ],
            user: auth.name || auth.accountId || "DuMate",
            signIn: "kept",
          }
        } catch (e) {
          return { error: cardText(e?.message) || "用量查询失败", signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
      },

      // Daily check-in. magpie asks once per Beijing day per signed-in account
      // while the provider's check-in switch is on, and again later that day
      // after a failure.
      //
      // Outcomes (the host's vocabulary): done = already claimed today,
      // claimed = this run claimed it, inactive = touched but nothing was
      // granted, failed = nothing claimed and worth retrying. `signIn:
      // "expired"` on a failed result tells magpie to mark the account and stop
      // retrying until the user signs in again.
      async checkin(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return {
            outcome: "failed",
            message: cardText(e?.message) || "登录态读取失败",
            ...(e?.signIn === "expired" ? { signIn: "expired" } : {}),
          }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return { outcome: "failed", message: "没有登录信息，请先在 Magpie 登录" }
        }
        const deadline = Date.now() + CHECKIN_BUDGET_MS
        try {
          const cookies = await consoleCookies(auth)
          const header = cookieHeaderOf(cookies)
          // hasIssued=true means today's bonus already landed. Read it before
          // touching the endpoint so "claimed now" is told apart from
          // "claimed hours ago".
          let before = null
          try {
            before = await cachedConsoleGet("bonus", "/api/dumate/points/loginBonusInfo", header)
          } catch (e) {
            // A dead session here is worth reporting, not swallowing: the POST
            // below would fail with a vaguer message.
            if (e?.signIn === "expired") throw e
          }
          if (before?.hasIssued === true) {
            return {
              outcome: "done",
              message: `今日已签到（累计 ${cardText(before.totalTimes) || "?"} 天）`,
            }
          }
          if (Date.now() >= deadline) {
            return { outcome: "failed", message: "签到超时，稍后自动重试" }
          }
          const beforePoints = parseFloat(before?.totalPoints ?? "0") || 0
          await consolePost("/api/dumate/points/loginBonus", {}, cookies)
          let after = null
          try {
            after = await consoleGet("/api/dumate/points/loginBonusInfo", header)
          } catch {}
          if (after?.hasIssued === true) {
            // Credit is derived from the actual delta, not hardcoded (+500 today
            // but the amount has changed before and may change again).
            const delta = Math.max(0, Math.round((parseFloat(after.totalPoints ?? "0") || 0) - beforePoints))
            return {
              outcome: "claimed",
              ...(delta ? { credit: delta } : {}),
              message: `签到成功${delta ? ` +${delta} 积分` : ""}（累计 ${cardText(after.totalTimes) || "?"} 天）`,
            }
          }
          // The POST went through but the ledger shows nothing yet. Saying
          // "claimed" would be a claim we cannot back; `inactive` is the honest
          // outcome, and the host re-asks later in the day.
          return { outcome: "inactive", message: "签到请求已提交，但今日积分尚未到账（可能延迟，稍后自动重试）" }
        } catch (e) {
          return {
            outcome: "failed",
            message: cardText(e?.message) || "签到失败",
            ...(e?.signIn === "expired" ? { signIn: "expired" } : {}),
          }
        }
      },

      methods: [
        {
          type: "oauth",
          label: "百度搭子桌面端登录态（本机 auth.json，只读复用）",
          authorize: async () => ({
            url: "",
            instructions: "直接复用本机百度搭子客户端的登录态（读取 auth.json + .cookie-key，只读，不写任何文件）。",
            method: "auto",
            async callback() {
              const d = readDesktopLogin()
              if (!d) {
                return {
                  type: "failed",
                  error: "未检测到本机百度搭子登录态（qianfan-desktop-app/auth.json）。请先安装并登录百度搭子，或改用浏览器登录方式。",
                }
              }
              const seat = seatIdentity(d)
              return {
                type: "success",
                access: "cookie:" + cookieHeaderOf(d.cookies),
                refresh: "",
                expires: 0,
                source: "desktop",
                accountId: seat.accountId,
                name: seat.name,
                cookies: d.cookies,
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "百度账号浏览器登录（无需安装百度搭子）",
          authorize: async () => ({
            url: LOGIN_URL,
            instructions:
              "1. 点击上方链接在浏览器登录百度账号（登录成功后会跳到 console.bce.baidu.com）。\n" +
              "2. 登录完成后，在 console.bce.baidu.com 页面按 F12 打开 DevTools → Network（网络）面板，刷新页面，点第一个请求。\n" +
              "3. 在 Request Headers（请求标头）里找到 Cookie 一行，右键 → Copy value（复制值），把整段粘贴到下方。\n" +
              "（不要用 document.cookie：关键登录 Cookie 是 httpOnly，控制台拿不到）",
            method: "code",
            async callback(input) {
              const raw = String(input ?? "").trim().replace(/^["']|["']$/g, "")
              if (!raw || !raw.includes("=")) return { type: "failed", error: "请粘贴请求头中 Cookie 行的完整值" }
              const cookies = parseCookieString(raw)
              const missing = REQUIRED_COOKIES.filter((n) => !cookies.some((c) => c.name === n))
              if (missing.length) {
                return { type: "failed", error: `Cookie 缺少关键字段：${missing.join(", ")}。请确认复制的是 DevTools Network 面板请求头里的 Cookie 值（不是 document.cookie）` }
              }
              const header = cookieHeaderOf(cookies)
              // Probe: validate the cookies actually work before accepting.
              let info = null
              try {
                info = await consoleGet("/api/dumate/user/info", header)
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}。请重新登录并复制新的 Cookie` }
              }
              const seat = seatIdentity({ accountId: info?.bceAccountId, name: info?.displayName, cookies })
              return {
                type: "success",
                access: "cookie:" + header,
                refresh: "",
                expires: 0,
                source: "browser",
                accountId: seat.accountId,
                name: seat.name,
                cookies,
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "手动粘贴 Cookie 字符串",
          authorize: async () => ({
            url: "",
            instructions: "粘贴完整的 Cookie 字符串（name=value; name2=value2 格式，需包含 bce-sessionid，来自 console.bce.baidu.com 的请求头）：",
            method: "code",
            async callback(input) {
              const raw = String(input ?? "").trim()
              const cookies = parseCookieString(raw)
              if (cookies.length < 2) return { type: "failed", error: "无法解析 Cookie 字符串" }
              const missing = REQUIRED_COOKIES.filter((n) => !cookies.some((c) => c.name === n))
              if (missing.length) return { type: "failed", error: `Cookie 缺少关键字段：${missing.join(", ")}` }
              const header = cookieHeaderOf(cookies)
              let info = null
              try {
                info = await consoleGet("/api/dumate/user/info", header)
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}` }
              }
              const seat = seatIdentity({ accountId: info?.bceAccountId, name: info?.displayName, cookies })
              return {
                type: "success",
                access: "cookie:" + header,
                refresh: "",
                expires: 0,
                source: "manual",
                accountId: seat.accountId,
                name: seat.name,
                cookies,
              }
            },
          }),
        },
      ],
    },
  }
}

export default DuMatePlugin

// Test hooks: pure helpers exported for unit tests (no network).
export const _internal = {
  parseCookieString,
  buildCookieHeader,
  extractCsrfToken,
  // Seat identity + cookie sanitising are pure, so they are testable without a
  // login and without the network.
  seatIdentity,
  fallbackAccountId,
  shouldFollowDesktop,
  usableCookies,
  cookieValue,
  readDesktopLogin,
  desktopUserDataDir,
  iconFromPluginDir,
  iconFromDesktopApp,
  iconFromBundle,
}
