#!/usr/bin/env node
// 缓存/延迟报告：读 magpie 的 ~/.config/magpie/usage.jsonl，按 provider/model 汇总。
//
// 为什么需要它：DuMate 网关**不上报**缓存命中字段（实测 usage 只有
// prompt_tokens / completion_tokens / total_tokens，没有 prompt_cache_hit_tokens），
// 所以「命中率」无法直接读。能观测的替代指标是：
//   - in > 0 的比例：说明这个 provider 的 token 用量终于可见了
//   - ttft 分布：同一会话里靠后的请求是否比开头的快（前缀被复用的间接证据）
// 但这只是间接证据：连接复用、网关预热也会让重复请求变快。脚本的输出严格区分
// 「测到了什么」和「推断」，不做断言。
//
// 用法：
//   node tools/cache-report.mjs                  # 全部 provider
//   node tools/cache-report.mjs --provider dumate
//   node tools/cache-report.mjs --sessions 6     # 额外看前 6 个长会话的 ttft 走势

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const provider = argOf("--provider", "")
const sessionCount = Number(argOf("--sessions", "0")) || 0
const path = join(homedir(), ".config/magpie/usage.jsonl")
if (!existsSync(path)) {
  console.error("找不到 " + path + "（magpie 可能没用过，或数据目录被移走了）")
  process.exit(1)
}

const rows = []
for (const line of readFileSync(path, "utf8").split("\n")) {
  if (!line.trim()) continue
  try {
    const j = JSON.parse(line)
    if (provider && j.provider !== provider) continue
    rows.push(j)
  } catch {}
}
if (!rows.length) {
  console.error("没有可统计的记录" + (provider ? `（provider=${provider}）` : ""))
  process.exit(1)
}

const pct = (arr, p) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}
const ms = (v) => (v == null ? "—" : `${Math.round(v)}ms`)
const num = (v) => (Number.isFinite(v) ? Math.round(v) : 0)

const groups = new Map()
for (const r of rows) {
  const key = `${r.provider} / ${r.served || r.model}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}

console.log(`数据源 ${path}`)
console.log(`记录数 ${rows.length}${provider ? `（provider=${provider}）` : ""}\n`)

for (const [key, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const withTokens = list.filter((r) => num(r.in) > 0)
  const ttft = list.map((r) => r.ttft_ms).filter((v) => Number.isFinite(v) && v > 0)
  const total = list.map((r) => r.ms).filter((v) => Number.isFinite(v) && v > 0)
  console.log(`## ${key}`)
  console.log(`   请求 ${list.length} | 有 token 记录的 ${withTokens.length}（${Math.round((withTokens.length / list.length) * 100)}%）`)
  if (withTokens.length) {
    const inSum = withTokens.reduce((a, r) => a + num(r.in), 0)
    const outSum = withTokens.reduce((a, r) => a + num(r.out), 0)
    console.log(`   tokens: in ${inSum} / out ${outSum}（平均 in ${Math.round(inSum / withTokens.length)}，out ${Math.round(outSum / withTokens.length)}）`)
  }
  const cached = list.filter((r) => num(r.cache_read) > 0).length
  console.log(`   带 cache_read 的记录 ${cached}/${list.length}` + (cached ? "" : " · 该 provider 不报缓存字段，命中率无法直接读"))
  console.log(`   ttft p50 ${ms(pct(ttft, 0.5))} / p90 ${ms(pct(ttft, 0.9))} · 总时长 p50 ${ms(pct(total, 0.5))} / p90 ${ms(pct(total, 0.9))}`)
  console.log("")
}

if (sessionCount) {
  const bySession = new Map()
  for (const r of rows) {
    if (!r.session) continue
    if (!bySession.has(r.session)) bySession.set(r.session, [])
    bySession.get(r.session).push(r)
  }
  const longs = [...bySession.entries()].filter(([, l]) => l.length >= 4).sort((a, b) => b[1].length - a[1].length).slice(0, sessionCount)
  if (!longs.length) {
    console.log("没有任何会话达到 4 条请求，跳过走势")
  } else {
    console.log("## 长会话 ttft 走势（前 3 条 vs 后 3 条）")
    for (const [sid, list] of longs) {
      const sorted = [...list].sort((a, b) => String(a.t).localeCompare(String(b.t)))
      const head = sorted.slice(0, 3).map((r) => r.ttft_ms).filter(Number.isFinite)
      const tail = sorted.slice(-3).map((r) => r.ttft_ms).filter(Number.isFinite)
      const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null)
      const h = avg(head), t = avg(tail)
      console.log(`   ${String(sid).slice(0, 12)}  ${sorted.length} 条 | 开头 ${ms(h)} → 末尾 ${ms(t)}${h && t ? `（${t < h ? "变快 " + Math.round((1 - t / h) * 100) + "%" : "变慢"}）` : ""}`)
    }
    console.log("\n   注意：变快不等于命中缓存——连接复用和网关预热同样会造成这个现象。")
  }
}