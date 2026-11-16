#!/usr/bin/env node
// 前缀缓存探针：交错发「稳定前缀」和「同长度全新前缀」，只比首字节。
//
// 为什么要交错：同一前缀连发两次会变快，但那是连接复用/网关预热，跟缓存无关。
// 只有「同长度、顺序交错、方向一致」的差异才算证据。
//
// 2026-11-15 实测（~6k tokens 前缀，各 3 次，S/F 交错）：
//   稳定前缀 首字节 1377 / 650 / 748 ms（中位 748）
//   全新前缀 首字节  671 / 581 /1139 ms（中位 671）
//   → 无差异。判读为「该网关不做前缀缓存（或缓存不体现在延迟上）」。
// 同一晚还试过 gzip 上传：网关返回 400 malformed_json，即不支持压缩传输。
//
// 这段代价是真金白银（每次约 6k prompt tokens），只在网关升级后复测时跑。
// 用法：node tools/cache-probe.mjs [--rounds 3] [--chars 4000]

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const rounds = Math.max(1, Number(argOf("--rounds", "3")) || 3)
const chars = Math.max(500, Number(argOf("--chars", "6000")) || 6000)

const authPath = join(homedir(), ".config/magpie/plugin-auth.json")
if (!existsSync(authPath)) {
  console.error("找不到 magpie 的 plugin-auth.json——先跑 magpie plugin login dumate")
  process.exit(1)
}
const stored = JSON.parse(readFileSync(authPath, "utf8")).dumate
if (!stored?.cookies?.length) {
  console.error("plugin-auth 里没有 dumate 的登录态")
  process.exit(1)
}

const here = new URL("./../index.mjs", import.meta.url).href
const { DuMatePlugin } = await import(here)
const hooks = await DuMatePlugin({})
const loader = await hooks.auth.loader(async () => ({ ...stored, type: "oauth" }))

const unit = "第 N 段：上下文缓存实验用固定文本，无时间戳无随机数，逐字节稳定。"
const other = "第 N 条：对照组文本，长度与稳定组一致，但内容完全不同，理应无法复用前缀。"
const build = (tpl) => {
  const one = tpl.length
  const n = Math.ceil(chars / one)
  return Array.from({ length: n }, (_, i) => tpl.replace("N", String(i + 1))).join("")
}
const stable = build(unit)
const fresh = build(other)

let spend = 0
async function probe(prefix, tag) {
  const body = JSON.stringify({
    model: "deepseek-v41-flash", stream: true, max_tokens: 4, temperature: 0,
    messages: [{ role: "system", content: prefix }, { role: "user", content: "回复 OK。" }],
  })
  const t0 = Date.now()
  const ac = new AbortController()
  const res = await loader.fetch("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ac.signal,
  })
  if (res.status !== 200) {
    console.log(tag, "HTTP", res.status, (await res.text()).slice(0, 160))
    return null
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = "", first = null, tokens = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split("\n")
    buf = parts.pop()
    for (const line of parts) {
      const s = line.trim()
      if (!s.startsWith("data:")) continue
      const p = s.slice(5).trim()
      if (p === "[DONE]") continue
      try {
        const j = JSON.parse(p)
        if (j.usage?.prompt_tokens) tokens = j.usage.prompt_tokens
        if (first == null) first = Date.now() - t0
      } catch {}
    }
    if (first != null && tokens != null) break
  }
  ac.abort()
  if (tokens) spend += tokens
  console.log(`${tag}: 首字节 ${first}ms` + (tokens ? ` | prompt_tokens ${tokens}` : " | 无 usage（老版本插件不会要）"))
  return { first, tokens }
}

const rows = []
for (let i = 0; i < rounds; i++) {
  const s = await probe(stable, `[稳定 #${i + 1}]`)
  if (s) rows.push({ k: "stable", ...s })
  const f = await probe(fresh, `[对照 #${i + 1}]`)
  if (f) rows.push({ k: "fresh", ...f })
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const st = rows.filter((r) => r.k === "stable").map((r) => r.first).filter((v) => v != null)
const fr = rows.filter((r) => r.k === "fresh").map((r) => r.first).filter((v) => v != null)
console.log("\n---")
console.log(`稳定前缀 首字节: ${st.join(" / ")} ms（中位 ${st.length ? med(st) : "—"}）`)
console.log(`全新前缀 首字节: ${fr.join(" / ")} ms（中位 ${fr.length ? med(fr) : "—"}）`)
if (st.length && fr.length) {
  const gap = med(fr) - med(st)
  console.log(`差 ${gap}ms`)
  console.log(gap > 500 ? "→ 稳定前缀明显更快，前缀缓存可能生效" : "→ 无显著差异，不能认定缓存生效")
}
console.log(`本轮消耗约 ${spend} prompt tokens（按网关汇率换算成本，脚本不估算）`)