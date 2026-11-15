// 请求节奏与熔断。
//
// 这里做的不是「伪装成官方客户端」——那类做法（换指纹、轮 IP、伪造设备号）我不做，
// 也不建议：服务端的风控判的是行为形状，频繁变化的指纹本身就是异常信号，而且真的
// 被判了，代价落在账号和积分上，不是落在插件上。
//
// 真正决定「像不像脚本」的是另一组特征，这些都在插件控制范围内：
//   1. 密度 —— 脚本会在几十毫秒里连发十几发，人会停一下
//   2. 退避 —— 脚本出错立刻重试，人看到报错会等一会
//   3. 一致性 —— 脚本每次头部都不太一样，真客户端一整天都长一个样
//   4. 无限重试 —— 会话死了之后脚本还在 hammer，这是最典型的特征
//
// 所以：给 console 接口（换 token / 查积分 / 签到）加最小间隔与抖动，
// 连续异常就熔断一段时间直接停手，而不是继续打。宁可这一轮报错，也不要把
// 账号推到风控的判据里去。
//
// 聊天请求不加间隔（那会直接拖慢 agent），只受熔断影响：熔断期间立刻失败返回，
// 让调用方知道「现在别发」，而不是排队攒一堆再一起撞上去。

const DEFAULTS = {
  // 两个 console 请求之间的最小间隔。换 token 本来就是小时级的，查积分是分钟级的，
  // 这个间隔只在并发/重试时起作用，正常路径完全不会慢。
  minIntervalMs: 800,
  // 抖动比例：间隔在 [base, base * (1 + jitter)) 之间随机。
  // 固定节奏本身也是一种机器特征，人不会每 800ms 整点发一次。
  jitter: 0.35,
  // 连续多少次异常判定为「该停手了」。
  tripAfter: 3,
  // 熔断时长；命中 Retry-After 时取两者较大值。
  cooldownMs: 15 * 60_000,
  // 注入点，方便测试不睡真实时间。
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
}

export function createGuard(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  let nextAt = 0
  let consecutive = 0
  let openUntil = 0

  // A caller that passes minIntervalMs is asserting a specific spacing (tests do),
  // so its value wins. Otherwise DUMATE_MIN_INTERVAL_MS can relax or tighten the
  // default without editing code — the runner sets it to 0 for offline suites.
  const pinned = Object.hasOwn(options, "minIntervalMs")
  const minInterval = () => {
    if (pinned) return cfg.minIntervalMs
    const raw = process.env.DUMATE_MIN_INTERVAL_MS
    if (raw === undefined || raw.trim() === "") return cfg.minIntervalMs
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : cfg.minIntervalMs
  }

  const isOpen = (at = cfg.now()) => at < openUntil

  const tripError = (at) => {
    const err = new Error(
      `DuMate 连续异常，已暂停 ${Math.ceil((openUntil - at) / 60000)} 分钟（避免继续重试触发风控）`,
    )
    err.riskGuard = true
    err.retryAt = openUntil
    return err
  }

  // 取得一次发请求的许可：熔断中直接抛错，否则等够间隔再放行。
  async function waitTurn() {
    const at = cfg.now()
    if (isOpen(at)) throw tripError(at)
    const base = minInterval()
    const start = Math.max(at, nextAt)
    nextAt = start + base + cfg.random() * base * cfg.jitter
    const delay = start - at
    if (delay > 0) await cfg.sleep(delay)
    // 等的时候可能刚好被别的请求熔断了。
    if (isOpen()) throw tripError(cfg.now())
  }

  // 每个结果都回报一次：成功清零，异常累加，够数就熔断。
  function note(ok, { retryAfterMs = 0 } = {}) {
    if (ok) {
      consecutive = 0
      return
    }
    consecutive += 1
    const at = cfg.now()
    if (consecutive >= cfg.tripAfter) {
      openUntil = Math.max(openUntil, at + Math.max(cfg.cooldownMs, retryAfterMs))
    } else if (retryAfterMs > 0) {
      // 服务端明确说了「过多久再来」，那就照它说的等，别自己加码。
      openUntil = Math.max(openUntil, at + retryAfterMs)
    }
  }

  // 200 但 body 是登录页 / 明确的限流码，这类「软失败」也要计入。
  function status() {
    return { open: isOpen(), openUntil, consecutive }
  }

  function reset() {
    nextAt = 0
    consecutive = 0
    openUntil = 0
  }

  return { waitTurn, note, status, reset, isOpen }
}

// 哪些响应算「该退避」而不是「该报错给用户」。
// 401/登录页是会话问题（要用户重新登录），不是节奏问题，不该靠等待解决，
// 所以它们不进熔断计数——否则一次正常的登出会白白锁掉 15 分钟。
export function classifyResponse({ status, retryAfterHeader } = {}) {
  const soft = status === 429 || status === 403 || (status >= 500 && status < 600)
  const retryAfterMs = (() => {
    const raw = String(retryAfterHeader ?? "").trim()
    if (!raw) return 0
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs, 3600) * 1000
    const when = Date.parse(raw)
    if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 3600 * 1000))
    return 0
  })()
  return { soft, retryAfterMs }
}
