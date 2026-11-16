// 让 token 用量能被看见，这是「吃上缓存命中」的前提。
//
// 实测（~/.config/magpie/usage.jsonl，2026-11-15 当晚 297 条 dumate 记录）：
//   in: 0, out: 0, cache_read: 0, cache_write: 0 —— 297/297 全是 0。
// 也就是说 magpie 不知道这个 provider 花了多少 token，更不知道有没有命中缓存，
// 面板上成本一直显示「—」。
//
// 原因是 OpenAI 兼容的流式响应默认**不**带 usage：它只在最后一个 chunk 里给，
// 而且要客户端显式要（`stream_options: { include_usage: true }`）。agent 走的是
// 流式，所以那一行永远读不到数。
//
// 这里只做一件事：调用方要了流式、又没自己指定 stream_options 时，补上
// include_usage。不改任何别的内容——尤其是 messages / tools / 参数，
// 那些是上游做前缀缓存的对象，动一个字节就可能从「命中」变成「未命中」。

export function withStreamUsage(body) {
  let text
  if (typeof body === "string") text = body
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) text = new TextDecoder().decode(body)
  else return body
  let request
  try { request = JSON.parse(text) } catch { return body }

  if (request?.stream !== true) return body
  // 调用方显式设过就尊重它（有人会为了兼容性关掉）。
  if (request.stream_options) return body

  request.stream_options = { include_usage: true }
  // JSON.stringify 保留原有键序，前缀字节不会因为这一改而变。
  return JSON.stringify(request)
}
// 557KB 的上行里到底装了什么：工具 schema？历史消息？系统提示？
// 这个分解只在 DUMATE_SIZE_LOG=1 时由调用方打印，平时零开销、零输出。
// 注意：只算字节，不读内容，永远不把 message 文本写进日志。
export function bodyBreakdown(body) {
  let text
  if (typeof body === "string") text = body
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) text = new TextDecoder().decode(body)
  else return null
  let request
  try { request = JSON.parse(text) } catch { return null }
  if (typeof request !== "object" || request === null) return null

  const size = (v) => {
    if (v === undefined || v === null) return 0
    try { return Buffer.byteLength(JSON.stringify(v), "utf8") } catch { return 0 }
  }
  const known = ["messages", "tools", "system", "input", "instructions"]
  const parts = {}
  for (const k of known) parts[k] = size(request[k])
  let other = 0
  for (const [k, v] of Object.entries(request)) {
    if (!known.includes(k)) other += size(v)
  }
  parts.other = other
  parts.total = Buffer.byteLength(text, "utf8")
  return parts
}

export function formatBreakdown(parts) {
  if (!parts) return ""
  const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`)
  const bits = ["messages", "tools", "system", "input", "instructions", "other"]
    .filter((k) => parts[k] >= 1024)
    .map((k) => `${k} ${kb(parts[k])}`)
  return `${kb(parts.total)}（${bits.join(" + ")}）`
}
