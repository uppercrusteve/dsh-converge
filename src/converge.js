// dsh-converge P2 — Converge｜科研收敛驾驶舱（host 端插件）
//
// P2 相对 P1 的三处改造（P1 遗留缺陷的对症）：
//   A 硬门控：passing = 总分≥0.85 且 G1 引用门 且 G2 结论门；conv_conclude 另加 G3 收尾门
//     （verdictSummary 为空 → 即使达标也拒绝）。加权分管进度，门管资格：光靠
//     coverage+counter+cite 凑到 0.85 而 synthesis=0 的边界，P2 起判 failing。
//   B treeVersion 证据隔离：converge/evidence 事件带 treeVersion；打分只认同版本证据
//     （旧会话里没有该字段的事件视为当前版本，保持兼容）。换树/追加子问题后旧证据
//     自动失效，同 ref 重新 conv_attach_evidence 即在新版本下重新激活。
//   C 提醒内容去重：turn-stopping 注入按 gapKey=`sqId|code` 去重，同一缺口每会话
//     只提醒一次（在 MAX_INJECTS=2 封顶之上叠加），出现新缺口才再提醒。
//
// 设计纪律（来自 P0 实测，违反 = 整机起不来）：
//   1. 不 import 任何 npm 包：只用 node: 内置模块 + Cordis ctx API。
//   2. inject 全有或全无：只 inject 确定存在且 apply 期就要用的核心服务，
//      其余一律 ctx.get(name) + try/catch 惰性探测。
//   3. 读 ctx 上不存在的属性会抛：所有能力探测走 safeGet / try-catch。
//   4. 自定义会话事件 session.append('converge/*', data)：data 必须严格 JSON 可序列化
//      （undefined / Date / Map / 非有限数字都会被拒），因此一切入库前先过 jsonable()。
//
// 状态全部事件溯源到 session：converge/plan · converge/evidence · converge/gap ·
// converge/verdict · converge/score · converge/conclude · converge/decision。
// 内存里的树只是事件流的重放投影（agent/created 时对已有会话重放一次）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-converge'
// headless 实测存在：tools / systemPrompt / agents / sessions / goals。
// 只 inject apply 期真正需要的两项，缩小启动失败面；agents/sessions 走惰性 ctx.get。
export const inject = ['tools', 'systemPrompt']

// ---------------------------------------------------------------- 常量

const THRESHOLD = 0.85
const MAX_INJECTS_PER_SESSION = 2
const EVENT_PREFIX = 'converge/'

const DEFAULT_CRITERIA = [
  { id: 'evidenceCoverage', kind: 'evidenceCoverage', weight: 0.35, target: 0.8 },
  { id: 'counterEvidence', kind: 'counterEvidence', weight: 0.25, target: 0.8 },
  { id: 'citationIntegrity', kind: 'citationIntegrity', weight: 0.25, target: 1 },
  { id: 'synthesisCoverage', kind: 'synthesisCoverage', weight: 0.15, target: 0.8 },
]

// conv_mark_gap 的 code 白名单（小写连字符）
const GAP_CODES = [
  'missing-evidence',
  'counter-evidence-unavailable',
  'counter-evidence-out-of-scope',
  'counter-evidence-unreadable',
  'citation-verification-pending',
  'synthesis-not-applicable',
  'language-access-limited',
  'paywall-access-limited',
  'time-constrained',
  'scope-boundary',
  'subquestion-dropped',
  'other',
]

const REF_KINDS = ['doi', 'pmid', 'arxiv', 'zotero', 'url']
const STANCES = ['supporting', 'counter', 'neutral']
const SLOT_KINDS = ['supporting', 'counter', 'method']

const RE = {
  doi: /^10\.\d{4,9}\/[^\s]{2,}$/,
  pmid: /^\d{5,9}$/,
  arxivNew: /^\d{4}\.\d{4,5}(v\d{1,2})?$/,
  arxivOld: /^(accenture|astro-ph|cond-mat|cs|gr-qc|hep-bh|hep-ex|hep-lat|hep-ph|hep-th|math|math-ph|nlin|nucl-ex|nucl-th|physics|quant-ph|q-bio|q-fin|stat)\/\d{7}(v\d{1,2})?$/i,
  zotero: /^[0-9A-Z]{8}$/,
  url: /^https?:\/\/[^\s]{4,}$/,
}

// ---------------------------------------------------------------- 纯函数（可单测）

/** 严格 JSON 化：丢掉 undefined、Date 之类退化、非有限数字转 null。 */
function jsonable (value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => { const j = jsonable(item); return j === undefined ? null : j })
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    const j = jsonable(v)
    if (j !== undefined) out[k] = j
  }
  return out
}

function round4 (n) { return Math.round((n + Number.EPSILON) * 10000) / 10000 }

function normId (kind, id) {
  const s = String(id ?? '').trim()
  return kind === 'doi' ? s.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '') : s
}

function evidenceKey (kind, id) { return `${String(kind).toLowerCase()}|${normId(kind, id)}` }

/** 引用格式校验（P1 只做格式核验，不发网络请求 → verified 的语义是“格式合法待联网核验”）。 */
function validateRef (kind, id) {
  const k = String(kind ?? '').toLowerCase()
  const v = String(id ?? '').trim()
  if (!REF_KINDS.includes(k)) return { ok: false, reason: `kind 必须是 ${REF_KINDS.join('/')} 之一` }
  if (!v) return { ok: false, reason: 'id 为空' }
  let ok = false
  let reason = ''
  if (k === 'doi') {
    ok = RE.doi.test(v)
    reason = 'DOI 需形如 10.xxxx/注册后缀（缺 registry 前缀或斜杠）'
  } else if (k === 'pmid') {
    ok = RE.pmid.test(v)
    reason = 'PMID 需 5–9 位纯数字'
  } else if (k === 'arxiv') {
    ok = RE.arxivNew.test(v) || RE.arxivOld.test(v)
    reason = 'arXiv 需 2301.12345 或 cs/0101001 形式'
  } else if (k === 'zotero') {
    ok = RE.zotero.test(v)
    reason = 'zotero key 需 8 位大写字母数字'
  } else if (k === 'url') {
    ok = RE.url.test(v) && v.length <= 500
    reason = 'url 需以 http(s):// 开头且不含空格'
  }
  return { ok, reason: ok ? '' : reason }
}

function defaultSlots (count) {
  const n = Math.max(0, Math.min(6, Number(count) || 0))
  const slots = []
  for (let i = 1; i <= n; i += 1) slots.push({ id: `s${i}`, kind: 'supporting', required: true })
  slots.push({ id: 'k1', kind: 'counter', required: true })
  return slots
}

/** 规范化一棵研究树；补齐 id / 槽位 / 默认准则。 */
function normalizePlan (input) {
  const list = Array.isArray(input?.subQuestions) ? input.subQuestions : []
  const seen = new Set()
  const subQuestions = []
  list.forEach((raw, i) => {
    const text = String(raw?.text ?? raw ?? '').trim()
    if (!text) return
    let id = String(raw?.id ?? `sq${i + 1}`).trim() || `sq${i + 1}`
    while (seen.has(id)) id = `${id}x`
    seen.add(id)
    const slots = Array.isArray(raw?.slots) && raw.slots.length
      ? raw.slots.map((s, j) => ({
        id: String(s?.id ?? `slot${j + 1}`),
        kind: SLOT_KINDS.includes(String(s?.kind)) ? String(s.kind) : 'supporting',
        required: s?.required !== false,
      }))
      : defaultSlots(raw?.requiredSlots ?? 1)
    subQuestions.push({ id, text, parentId: raw?.parentId ? String(raw.parentId) : '', criteria: Array.isArray(raw?.criteria) ? raw.criteria.map(String) : [], slots })
  })
  const criteria = (Array.isArray(input?.criteria) && input.criteria.length ? input.criteria : DEFAULT_CRITERIA).map((c, i) => ({
    id: String(c?.id ?? `c${i + 1}`),
    kind: String(c?.kind ?? c?.id ?? `c${i + 1}`),
    weight: typeof c?.weight === 'number' ? c.weight : DEFAULT_CRITERIA.find((d) => d.kind === String(c?.kind ?? c?.id))?.weight ?? 0.25,
    target: typeof c?.target === 'number' ? c.target : 0.8,
  }))
  return {
    researchQuestion: String(input?.researchQuestion ?? '').trim(),
    criteria,
    subQuestions,
  }
}

function initialState () {
  return { plan: null, treeVersion: 0, evidence: [], gaps: [], verdicts: [], scores: [], conclusion: null, injects: 0, steerCount: 0, blocks: 0, reminded: [] }
}

/** 证据是否属于当前树版本（P2-B）：旧事件没有 treeVersion → 视为当前版本。 */
function isCurrentEvidence (e, treeVersion) {
  if (typeof e?.treeVersion !== 'number') return true
  return e.treeVersion === (treeVersion ?? 0)
}

/** 提醒去重的键（P2-C）：同一 sqId+code 的缺口每会话只提醒一次。 */
function gapKeyOf (g) { return `${g?.sqId || '-'}|${g?.code || '?'}` }

/** 硬门控（P2-A）：G1 引用门 + G2 结论门（G3 在 conv_conclude 侧，需要 args）。 */
function buildGates (parts, info) {
  const g1 = { gate: 'G1', name: '引用门', pass: parts.citationIntegrity === 1, reasons: [] }
  if (!g1.pass) {
    if (!info.refs) g1.reasons.push('没有任何可解析的引用（citationIntegrity=0）：先 conv_attach_evidence 挂上真实 DOI/PMID/arXiv/url')
    for (const e of info.invalid) g1.reasons.push(`${e.ref?.kind}:${e.ref?.id} 不可解析（${e.verifyReason || '格式非法'}）：换合法标识符重挂，或 conv_mark_gap code:"citation-verification-pending" 明示待联网核验`)
  }
  const g2 = { gate: 'G2', name: '结论门', pass: info.answered === info.withVerdict, reasons: [] }
  if (!g2.pass) g2.reasons.push(`${info.answered - info.withVerdict} 个已作答子问题没有 verdict（answered=${info.answered}，verdicts=${info.withVerdict}）：conv_conclude 的 verdicts 里逐条给 {sqId, claim, confidence}`)
  if (info.answered === 0) g2.reasons.push('（answered=0 → G2 视为通过：还没有子问题被证据作答）')
  return [g1, g2]
}

/** 三道门的完整报告（G1/G2 来自打分，G3 看 conv_conclude 的正文）。 */
function gateReport (score, args) {
  const gates = (score?.gates ?? []).map((g) => ({ ...g, reasons: g.reasons.filter((r) => r) }))
  const summary = String(args?.verdictSummary ?? '').trim()
  gates.push({ gate: 'G3', name: '收尾门', pass: summary.length > 0, reasons: summary.length ? [] : ['verdictSummary 为空：收尾必须给出给用户看的那段人话结论（即使达标也要正文）'] })
  return gates
}

/** 事件 → 状态投影（幂等：同一 ref 重复出现不会虚增）。 */
function reduceEvent (state, ev) {
  const type = String(ev?.type ?? '')
  if (!type.startsWith(EVENT_PREFIX)) return state
  const d = ev.data ?? {}
  if (type === 'converge/plan') {
    state.plan = d.plan ?? null
    state.treeVersion = typeof d.treeVersion === 'number' ? d.treeVersion : state.treeVersion + 1
    return state
  }
  if (type === 'converge/evidence') {
    const key = d.key || evidenceKey(d.ref?.kind, d.ref?.id)
    const tv = typeof d.treeVersion === 'number' ? d.treeVersion : undefined
    const at = state.evidence.findIndex((e) => e.key === key)
    if (at >= 0) {
      const prev = state.evidence[at]
      const prevTv = typeof prev.treeVersion === 'number' ? prev.treeVersion : -1
      // 同版本重复挂 → 去重不虚增（重放幂等）；更高版本重挂 → 在旧条目上"重新激活"
      if (tv === undefined || tv <= prevTv) return state
      state.evidence[at] = { ...prev, sqId: d.sqId, slotId: d.slotId ?? '', ref: d.ref, verified: d.verified === true, verifyReason: d.verifyReason ?? '', treeVersion: tv, reactivateSeq: ev.seq }
      return state
    }
    state.evidence.push({ sqId: d.sqId, slotId: d.slotId ?? '', ref: d.ref, verified: d.verified === true, verifyReason: d.verifyReason ?? '', key, ...(tv === undefined ? {} : { treeVersion: tv }), seq: ev.seq, time: ev.time })
    return state
  }
  if (type === 'converge/gap') {
    state.gaps.push({ sqId: d.sqId ?? '', code: d.code, detail: d.detail ?? '', seq: ev.seq, time: ev.time })
    return state
  }
  if (type === 'converge/verdict') {
    const at = state.verdicts.findIndex((v) => v.sqId === d.sqId)
    const rec = { sqId: d.sqId, claim: d.claim, confidence: typeof d.confidence === 'number' ? d.confidence : 0.7, seq: ev.seq, time: ev.time }
    if (at >= 0) state.verdicts.splice(at, 1, rec)
    else state.verdicts.push(rec)
    return state
  }
  if (type === 'converge/score') { state.scores.push({ seq: ev.seq, time: ev.time, score: d }); return state }
  if (type === 'converge/conclude') { state.conclusion = { status: d.status, score: d.score ?? null, seq: ev.seq, time: ev.time }; return state }
  if (type === 'converge/decision') {
    if (d.action === 'steer' || d.action === 'followup' || d.action === 'deferContext') state.injects += 1
    if (d.action === 'steer') state.steerCount += 1
    if (d.action === 'block') state.blocks += 1
    for (const k of Array.isArray(d.gapKeys) ? d.gapKeys : []) { if (typeof k === 'string' && !state.reminded.includes(k)) state.reminded.push(k) }
    return state
  }
  return state
}

function replay (events) {
  const state = initialState()
  for (const ev of events ?? []) { try { reduceEvent(state, ev) } catch { /* 坏事件跳过 */ } }
  return state
}

function weightsOf (plan) {
  const w = { evidenceCoverage: 0.35, counterEvidence: 0.25, citationIntegrity: 0.25, synthesisCoverage: 0.15 }
  for (const c of plan?.criteria ?? []) if (typeof c.weight === 'number' && c.kind in w) w[c.kind] = c.weight
  return w
}

function activeSubQuestions (state) {
  const dropped = new Set(state.gaps.filter((g) => g.code === 'subquestion-dropped' && g.sqId).map((g) => g.sqId))
  return (state.plan?.subQuestions ?? []).filter((sq) => !dropped.has(sq.id))
}

function slotFilled (state, sqId, slotId) {
  return state.evidence.some((e) => e.sqId === sqId && e.slotId === slotId)
}

/** 打分 + 具体缺口 + 每条缺口的最短补法。 */
function computeScore (state) {
  const w = weightsOf(state.plan)
  if (!state.plan || state.plan.subQuestions.length === 0) {
    return {
      total: 0, threshold: THRESHOLD, passing: false, parts: { evidenceCoverage: 0, counterEvidence: 0, citationIntegrity: 0, synthesisCoverage: 0 },
      gates: buildGates({ evidenceCoverage: 0, counterEvidence: 0, citationIntegrity: 0, synthesisCoverage: 0 }, { refs: 0, invalid: [], answered: 0, withVerdict: 0 }),
      blockingGates: ['G1'], treeVersion: state.treeVersion ?? 0,
      gaps: [{ code: 'no-plan', sqId: '', detail: '还没有研究树，无法打分' }],
      advice: [`调用 conv_plan {researchQuestion, subQuestions:[{text, requiredSlots:1}]} 先立一棵最小树`],
      nextBestAction: 'conv_plan 建立研究树',
      counts: { subQuestions: 0, requiredSlots: 0, filledSlots: 0, evidence: state.evidence.length, evidenceCurrent: 0, staleEvidence: state.evidence.length, invalidRefs: 0, answered: 0, verdicts: 0, counterOk: 0 },
      verifiedIsFormatOnly: true,
    }
  }
  const active = activeSubQuestions(state)
  const treeVersion = state.treeVersion ?? 0
  // P2-B：打分只认当前树版本的证据（没有 treeVersion 字段的旧事件视为当前版本）
  const evid = state.evidence.filter((e) => isCurrentEvidence(e, treeVersion))
  const staleEvidence = state.evidence.length - evid.length
  const requiredSlots = []
  for (const sq of active) for (const slot of sq.slots ?? []) if (slot.required) requiredSlots.push({ sqId: sq.id, slot })
  const filledSlots = requiredSlots.filter((rs) => evid.some((e) => e.sqId === rs.sqId && e.slotId === rs.slot.id))
  const coverage = requiredSlots.length ? filledSlots.length / requiredSlots.length : 0

  const answered = active.filter((sq) => evid.some((e) => e.sqId === sq.id))
  const counterOk = answered.filter((sq) => evid.some((e) => e.sqId === sq.id && e.ref?.stance === 'counter' && e.verified))
  const counter = answered.length ? counterOk.length / answered.length : 0

  // 引用完整性：格式非法的引用拖分；但被 conv_mark_gap(citation-verification-pending)
  // 明确挂"待联网核验"的那几条，从分母移出（承认待核验 ≠ 假装它合法）。
  const invalid = evid.filter((e) => !e.verified)
  const pendingGaps = state.gaps.filter((g) => g.code === 'citation-verification-pending')
  const pendingAll = pendingGaps.some((g) => !g.sqId)
  const pendingSq = new Set(pendingGaps.filter((g) => g.sqId).map((g) => g.sqId))
  const isPending = (e) => pendingAll || pendingSq.has(e.sqId)
  const pendingInvalid = invalid.filter(isPending)
  const countedInvalid = invalid.filter((e) => !isPending(e))
  const countedRefs = evid.length - pendingInvalid.length
  const cite = evid.length === 0
    ? 0
    : countedRefs === 0 ? 1 : (countedRefs - countedInvalid.length) / countedRefs

  const withVerdict = answered.filter((sq) => state.verdicts.some((v) => v.sqId === sq.id))
  const synth = answered.length ? withVerdict.length / answered.length : 0

  const parts = {
    evidenceCoverage: round4(coverage),
    counterEvidence: round4(counter),
    citationIntegrity: round4(cite),
    synthesisCoverage: round4(synth),
  }
  const total = round4(
    w.evidenceCoverage * parts.evidenceCoverage +
    w.counterEvidence * parts.counterEvidence +
    w.citationIntegrity * parts.citationIntegrity +
    w.synthesisCoverage * parts.synthesisCoverage,
  )

  const sqText = (id) => { const sq = (state.plan.subQuestions ?? []).find((s) => s.id === id); return sq ? `${id}(${String(sq.text).slice(0, 24)})` : id }
  const gaps = []
  if (staleEvidence > 0) {
    gaps.push({
      code: 'stale-evidence', sqId: '',
      detail: `${staleEvidence} 条证据挂在旧树版本（当前 treeVersion=${treeVersion}），按 P2 隔离规则不计分：同一批必填槽现在是空的`,
      fix: '把已知的引用按当前树重挂一遍：同样 kind+id 再 conv_attach_evidence 一次即可在新 treeVersion 下重新激活（不会重复计分）',
    })
  }
  for (const rs of requiredSlots) {
    if (filledSlots.includes(rs)) continue
    const stance = rs.slot.kind === 'counter' ? 'counter' : rs.slot.kind === 'method' ? 'neutral' : 'supporting'
    gaps.push({
      code: 'missing-evidence', sqId: rs.sqId,
      detail: `${sqText(rs.sqId)} 必填槽 ${rs.slot.id}(${rs.slot.kind}) 无证据`,
      fix: `conv_attach_evidence {sqId:"${rs.sqId}", slotId:"${rs.slot.id}", kind:"doi", id:"10.xxxx/yyyy", stance:"${stance}"}`,
    })
  }
  for (const sq of answered) {
    if (counterOk.includes(sq)) continue
    gaps.push({
      code: 'counterEvidence', sqId: sq.id,
      detail: `${sqText(sq.id)} 已作答但没有已核验的反例（counterEvidence 被拖分）`,
      fix: `给 ${sq.id} 附一条结论相反的文献：conv_attach_evidence {sqId:"${sq.id}", kind:"doi", id:"...", stance:"counter"}；确实找不到就 conv_mark_gap {sqId:"${sq.id}", code:"counter-evidence-unavailable", detail:"为什么没有反例"}`,
    })
  }
  for (const e of countedInvalid) {
    gaps.push({
      code: 'invalid-citation', sqId: e.sqId,
      detail: `${sqText(e.sqId)} 的引用 ${e.ref?.kind}:${e.ref?.id} 格式不合法（${e.verifyReason || '未知原因'}），citationIntegrity 记 0 且 G1 引用门不放行`,
      fix: `修掉这条引用：${e.ref?.kind} 需要合法标识符（DOI 形如 10.xxxx/后缀）；换 correct id 重新 conv_attach_evidence，或 conv_mark_gap code:"citation-verification-pending" 说明待联网核验`,
    })
  }
  for (const sq of answered) {
    if (withVerdict.includes(sq)) continue
    gaps.push({
      code: 'missing-verdict', sqId: sq.id,
      detail: `${sqText(sq.id)} 有证据但没有 verdict 结论（synthesisCoverage 记 0 且 G2 结论门不放行）`,
      fix: `conv_conclude 时在 verdicts 里给 ${sq.id} 写 {sqId:"${sq.id}", claim:"一句话结论", confidence:0.7}`,
    })
  }
  if (!evid.length) {
    gaps.unshift({
      code: 'no-evidence', sqId: '',
      detail: staleEvidence > 0 ? `当前树版本（treeVersion=${treeVersion}）没有任何证据：${staleEvidence} 条旧版本证据已被隔离` : '本会话还没有任何证据条目',
      fix: '先用 conv_attach_evidence 挂上你已经知道的文献（哪怕先只挂 1 条支持 + 1 条反例）',
    })
  }
  const advice = gaps.map((g) => g.fix).filter(Boolean)

  const gates = buildGates(parts, { refs: evid.length, invalid: countedInvalid, answered: answered.length, withVerdict: withVerdict.length })
  const blockingGates = gates.filter((g) => !g.pass).map((g) => g.gate)
  const priority = { missingEvidence: w.evidenceCoverage * (1 - parts.evidenceCoverage), counterEvidence: w.counterEvidence * (1 - parts.counterEvidence), citationIntegrity: w.citationIntegrity * (1 - parts.citationIntegrity), synthesisCoverage: w.synthesisCoverage * (1 - parts.synthesisCoverage) }
  const worst = Object.entries(priority).sort((a, b) => b[1] - a[1])[0]
  const nextMap = {
    missingEvidence: '补必填证据槽（conv_attach_evidence 带 slotId）',
    counterEvidence: '补一条 stance:"counter" 的反例文献，或 conv_mark_gap 说明反例不可得',
    citationIntegrity: '修掉格式不合法的引用（DOI/PMID/arXiv/url 必须能解析）',
    synthesisCoverage: '给每个已作答子问题写 verdict（conv_conclude 的 verdicts 参数）',
  }
  const gateNext = {
    G1: '硬门 G1（引用门）未过：每条已挂证据的 ref 都要能解析（DOI 10.xxxx/后缀、PMID 数字、arXiv 号、合法 url），或 conv_mark_gap citation-verification-pending 明示待核验',
    G2: '硬门 G2（结论门）未过：每个已作答子问题都要有 verdict（conv_conclude 的 verdicts 逐条给 {sqId, claim}）',
  }
  // P2-A：门管资格、加权分只管进度 —— 总分够但没有过 G1/G2 也不算 passing
  const passing = total >= THRESHOLD && blockingGates.length === 0

  return {
    total,
    threshold: THRESHOLD,
    passing,
    parts,
    weights: w,
    gates,
    blockingGates,
    treeVersion,
    gaps: gaps.slice(0, 12),
    advice: advice.filter((v, i, a) => a.indexOf(v) === i).slice(0, 6),
    nextBestAction: passing
      ? '可以收尾：conv_conclude {verdictSummary, verdicts}（verdictSummary 不能为空，G3 收尾门要读它）'
      : (blockingGates.length ? blockingGates.map((g) => gateNext[g]).filter(Boolean).join(' ｜ ') : (nextMap[worst[0]] ?? '补证据')),
    counts: {
      subQuestions: active.length,
      requiredSlots: requiredSlots.length,
      filledSlots: filledSlots.length,
      evidence: state.evidence.length,
      evidenceCurrent: evid.length,
      staleEvidence,
      invalidRefs: invalid.length,
      unresolvedInvalidRefs: countedInvalid.length,
      pendingCitations: pendingInvalid.length,
      answered: answered.length,
      verdicts: withVerdict.length,
      counterOk: counterOk.length,
    },
    verifiedIsFormatOnly: true,
  }
}

/** 自动落槽：stance 决定槽 kind；不匹配就不硬塞（保持指标诚实）。 */
function pickSlot (plan, sqId, stance, takenIds) {
  const sq = (plan?.subQuestions ?? []).find((s) => s.id === sqId)
  if (!sq) return ''
  const want = stance === 'counter' ? 'counter' : stance === 'neutral' ? 'method' : 'supporting'
  const open = (sq.slots ?? []).filter((s) => !takenIds.has(s.id))
  return (open.find((s) => s.kind === want) ?? (want === 'supporting' ? open.find((s) => s.kind === 'method') : undefined))?.id ?? ''
}

// ---------------------------------------------------------------- P3a：宿主事件类型注册面（resume 兼容）
//
// 问题：dsh-session-persistence 读侧对不在 KNOWN_SESSION_EVENT_TYPES、又没有 ignorable
// 标记的事件类型直接拒绝装载整个会话（SessionFormatUnsupportedError: unknown to this
// harness and not marked ignorable），带 converge/* 事件的会话因此官方 ctx.agents.resume
// 装载即拒。官方注册面由生成 catalog 锁死（known-event-types.js 注释：下游插件事件
// "registration surface is deferred until such a consumer exists"），session.append 也
// 没有传 ignorable 的口子，所以走 R1 定案的运行时注册：
//   从宿主入口路径（process.argv[1] 优先；web 宿主/子进程取不到时按 argvN → execArgv →
//   import.meta → 已知安装根常量逐个探径）反推宿主 node_modules 根，用 pathToFileURL
//   import 宿主**同一份** @deepseek-ai/dsh-session（插件装在 D:\ 下，裸包名要么解析不到
//   要么拿到第二份拷贝——必须解析到同一文件实例，ESM 模块缓存才保证这是 persistence 读侧
//   import 的那活同一个 Set；resume-harness 在 T9b2 已验证这条推径端到端可行），
//   然后 .add() 本插件的事件类型。同实例探针 = Set 里必须已有本 build 的已知类型
//   （'goal/change'），否则视作"另一份拷贝/不是那份词表"，不注册。
// 降级语义：注册是纯增量——失败只会让"带 converge/* 的历史会话无法 resume"，本会话的
// 工具/事件/拦截功能不受损。因此任何一步失败只记 ctx.logger.warn + 结构化日志
// ev:'event-types-register'（outcome ok/degraded、mode=探径来源、resolvedFrom、
// missingBefore/missingAfter 证据链），绝不抛出弄挂插件树。

const CONVERGE_EVENT_TYPES = [
  'converge/plan',
  'converge/evidence',
  'converge/gap',
  'converge/verdict',
  // P3b：设置变更事件（宿主 RPC setSetting 落盘用；reduceEvent 对未知 converge/* 天然忽略，不动四套逻辑）
  'converge/setting',
  'converge/score',
  'converge/conclude',
  'converge/decision',
  'converge/ping', // P0 探测期写过的类型：历史隔离 home 的会话里存在，一并注册防装载即拒
]
const PROBE_EVENT_TYPE = 'goal/change'
// 每个 node_modules 根要试的两个包内路径：index.js 是 persistence import 的包入口（首选）；
// types/known-event-types.js 是 catalog 源文件（宿主打包形态下可能是另一个实例，顺手都加）。
const HOST_PKG_TARGETS = [
  ['@deepseek-ai', 'dsh-session', 'lib', 'index.js'],
  ['@deepseek-ai', 'dsh-session', 'lib', 'types', 'known-event-types.js'],
]
// 备用探径的最后一档：本机已知宿主安装根（node_modules 就在 app 目录下）。
const HOST_INSTALL_ROOTS = [
  'C:\\Users\\YilongXiao\\AppData\\Local\\Programs\\DSH Desktop\\resources\\app',
]
const CANDIDATE_ANCESTOR_HOPS = 10
const CANDIDATE_LIMIT = 48

function looksLikeJsEntry (value) {
  return typeof value === 'string' && path.isAbsolute(value) && /\.(c|m)?js$/i.test(value)
}

/** 纯函数：从一个宿主文件路径（bin.js / main.cjs…）反推 dsh-session 候选 file URL（逐级上溯找 node_modules）。 */
function candidatesFromPath (entry, mode) {
  const out = []
  let dir = path.dirname(path.resolve(entry))
  for (let hop = 0; hop <= CANDIDATE_ANCESTOR_HOPS; hop += 1) {
    const inNodeModules = path.basename(dir).toLowerCase() === 'node_modules'
    const roots = inNodeModules ? [dir] : [path.join(dir, 'node_modules')]
    for (const rel of HOST_PKG_TARGETS) {
      for (const root of roots) out.push({ href: pathToFileURL(path.join(root, ...rel)).href, mode })
    }
    if (inNodeModules) break // 命中最近的 node_modules 根就够了，再往上都是噪音
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return out
}

/** 纯函数：按 argv1 → argvN → execArgv → import.meta → 安装根常量的顺序产候选（去重、限量）。 */
function deriveRegisterCandidates ({ argv = [], execArgv = [], pluginUrl = '' } = {}) {
  const notes = []
  const entries = []
  if (looksLikeJsEntry(argv[1])) entries.push([argv[1], 'argv1'])
  else if (argv[1]) notes.push(`argv1 不是绝对 .js/.cjs/.mjs 路径：${String(argv[1]).slice(0, 100)}`)
  for (const a of Array.isArray(argv) ? argv.slice(2) : []) if (looksLikeJsEntry(a)) entries.push([a, 'argvN'])
  for (const a of Array.isArray(execArgv) ? execArgv : []) if (looksLikeJsEntry(a)) entries.push([a, 'execArgv'])
  if (pluginUrl && String(pluginUrl).startsWith('file:')) {
    try { entries.push([fileURLToPath(String(pluginUrl)), 'import.meta']) } catch { notes.push('pluginUrl 无法转为文件路径') }
  }
  const out = []
  const seen = new Set()
  const add = (cand) => { if (!seen.has(cand.href) && out.length < CANDIDATE_LIMIT) { seen.add(cand.href); out.push(cand) } }
  for (const [entry, mode] of entries) for (const cand of candidatesFromPath(entry, mode)) add(cand)
  for (const root of HOST_INSTALL_ROOTS) {
    for (const rel of HOST_PKG_TARGETS) add({ href: pathToFileURL(path.join(root, 'node_modules', ...rel)).href, mode: 'constant' })
  }
  return { candidates: out, notes }
}

/** 纯函数：模块命名空间 → 是否可信的注册目标；探针类型（goal/change）缺席就当"第二份拷贝"拒注。 */
function evaluateRegisterTarget (mod) {
  const set = mod ? mod.KNOWN_SESSION_EVENT_TYPES : undefined
  if (!set || typeof set.has !== 'function' || typeof set.add !== 'function') {
    return { ok: false, reason: '模块没有可写的 KNOWN_SESSION_EVENT_TYPES Set' }
  }
  if (!set.has(PROBE_EVENT_TYPE)) {
    return { ok: false, reason: `探针类型 "${PROBE_EVENT_TYPE}" 不在集合里（不是本 build 的那份词表/第二份拷贝），不注册` }
  }
  return { ok: true, set }
}

/**
 * 注册本体。opts 全部可注入（argv/execArgv/pluginUrl/importer），方便纯函数式单测；
 * 默认值走真实 process/import.meta。绝不抛出（调用方另有 try/catch 兜底），返回结构化结果。
 * 命中多个有效目标时全部注册（index.js + known-event-types.js 两种打包形态都覆盖）。
 */
async function registerEventTypes (opts = {}) {
  const argv = opts.argv || process.argv
  const execArgv = opts.execArgv || process.execArgv
  const pluginUrl = opts.pluginUrl !== undefined ? opts.pluginUrl : import.meta.url
  const importer = opts.importer || ((href) => import(href))
  const t0 = Date.now()
  const plan = deriveRegisterCandidates({ argv, execArgv, pluginUrl })
  const targets = []
  const failures = []
  let primary = null
  for (const cand of plan.candidates) {
    let mod = null
    try { mod = await importer(cand.href) } catch (e) { failures.push({ href: cand.href, mode: cand.mode, error: String((e && e.message) || e).slice(0, 140) }); continue }
    const verdict = evaluateRegisterTarget(mod)
    if (!verdict.ok) { failures.push({ href: cand.href, mode: cand.mode, error: verdict.reason }); continue }
    const missingBefore = CONVERGE_EVENT_TYPES.filter((t) => !verdict.set.has(t))
    for (const t of CONVERGE_EVENT_TYPES) verdict.set.add(t)
    const missingAfter = CONVERGE_EVENT_TYPES.filter((t) => !verdict.set.has(t))
    const rec = { href: cand.href, mode: cand.mode, sizeAfter: verdict.set.size, missingBefore, missingAfter }
    targets.push(rec)
    if (!primary) primary = rec
  }
  const out = {
    outcome: primary && primary.missingAfter.length === 0 ? 'ok' : 'degraded',
    mode: primary ? primary.mode : 'none',
    resolvedFrom: primary ? primary.href : null,
    probe: PROBE_EVENT_TYPE,
    typesTotal: CONVERGE_EVENT_TYPES.length,
    missingBefore: primary ? primary.missingBefore : CONVERGE_EVENT_TYPES,
    missingAfter: primary ? primary.missingAfter : CONVERGE_EVENT_TYPES,
    registeredTargets: targets.length,
    candidateCount: plan.candidates.length,
    argv1: argv[1] || null,
    notes: plan.notes,
    failures: failures.slice(-6),
    ms: Date.now() - t0,
  }
  if (!primary) out.reason = '所有探径都失败：没拿到暴露含探针类型的可写 KNOWN_SESSION_EVENT_TYPES 的模块'
  return out
}

// ---------------------------------------------------------------- P3b：会话投影（纯函数部分）
//
// 把事件流折叠成客户端可直接消费的 JSON 状态：
//   - byTurn：按宿主 turn 序号（turn/start 事件 data.turn，与 TurnTail 路由同一编号）索引的摘要，
//     无 turn 归属的早期事件记在 'pre' 桶（诚实显示"没挂上回合"，不假装是别的回合）。
//   - settings：converge/setting 事件的镜像（设置分节展示"最近一次持久化的开关"）。
// 折叠复用 reduceEvent/computeScore（四套逻辑是单一事实源，这里只是低频摘要，不改它们的行为）。
// stateSchema / viewSchema 用宿主契约允许的手写透传 codec：dsh-typert-registry validateCodec 只
// 要求 codec.schema.parse 是函数，sessionProjections restore() 用 stateSchema.parse(row.val) 复原
// ——状态全部出自 jsonable，透传即合法。
// 迟到注册无需特殊处理：dsh-session-projection 对内存日志按 init→apply 全量折叠（watermark fold），
// 注册之后首次触达即得到完整历史状态；本折叠对事件顺序不敏感（turn 归属用事件自带 turn 优先）。

const PV_KEY = 'converge'
const PV_STATE_VERSION = 1
const PV_TURN_CAP = 40
const pvPassthrough = { parse: (v) => v }

function pvInit () {
  return { turn: null, conv: initialState(), turns: {}, order: [], settings: {} }
}

/** 回合摘要：只保留三块 UI 需要的低频字段（数字、状态、top3 缺口、nextBestAction）。 */
function pvDigest (conv, turnKey, ev) {
  const sc = computeScore(conv)
  return {
    turn: turnKey,
    hasPlan: !!conv.plan,
    treeVersion: sc.treeVersion,
    total: sc.total,
    threshold: sc.threshold,
    passing: sc.passing,
    status: conv.conclusion ? conv.conclusion.status : null,
    gaps: sc.gaps.slice(0, 3).map((g) => ({ code: g?.code ?? '?', sqId: g?.sqId || '', detail: String(g?.detail ?? '').slice(0, 90) })),
    gapCount: sc.gaps.length,
    blockingGates: sc.blockingGates,
    counts: {
      evidence: sc.counts.evidenceCurrent,
      answered: sc.counts.answered,
      verdicts: sc.counts.verdicts,
      invalidRefs: sc.counts.unresolvedInvalidRefs,
      staleEvidence: sc.counts.staleEvidence,
    },
    nextBestAction: String(sc.nextBestAction ?? '').slice(0, 200),
    ts: Number.isFinite(ev?.time) && ev.time > 0 ? ev.time : Date.now(),
  }
}

/** 投影折叠：turn/start 记当前回合号；converge/setting 记设置镜像；其余 converge/* 走 reduceEvent+digest。 */
function pvApply (state, event) {
  const type = String(event?.type ?? '')
  if (type === 'turn/start') {
    const t = Number.isFinite(event?.data?.turn) ? event.data.turn : null
    return t === null || t === state.turn ? state : { ...state, turn: t }
  }
  if (!type.startsWith(EVENT_PREFIX)) return state
  if (type === 'converge/setting') {
    const key = String(event?.data?.key ?? '')
    if (!key) return state
    return { ...state, settings: { ...state.settings, [key]: event?.data?.value ?? null } }
  }
  const turnKey = Number.isFinite(event?.data?.turn)
    ? String(event.data.turn)
    : (Number.isFinite(state.turn) ? String(state.turn) : 'pre')
  let conv
  try {
    conv = structuredClone(state.conv)
    reduceEvent(conv, event)
  } catch { return state }
  let digest
  try { digest = pvDigest(conv, turnKey, event) } catch { return { ...state, conv } }
  const turns = { ...state.turns, [turnKey]: digest }
  let order = state.order.includes(turnKey) ? state.order.slice() : [...state.order, turnKey]
  while (order.length > PV_TURN_CAP) {
    const drop = order.shift()
    if (drop !== turnKey) delete turns[drop]
  }
  return { ...state, conv, turns, order }
}

/** wire 视图（推给客户端）：byTurn + latest + settings 镜像。全部 JSON 可序列化。 */
function pvView (state) {
  const latestKey = state.order.length ? state.order[state.order.length - 1] : null
  return {
    key: PV_KEY,
    stateVersion: PV_STATE_VERSION,
    turn: state.turn,
    hasPlan: !!state.conv.plan,
    treeVersion: state.conv.treeVersion,
    latest: latestKey ? state.turns[latestKey] : null,
    byTurn: state.turns,
    settings: { ...state.settings },
  }
}

/** 宿主 typert 清单（手写，与 cost-meter 的 ./typert 产物结构一致；零 npm 依赖所以走手动 ctx.typert.register）。 */
const RPC_TYPE = 'dsh-converge'
const RPC_SERVICE = 'convergeApi'
const RPC_NAMESPACE = 'converge'
function pvCodec (typeSymbol, guard) {
  return {
    mode: 'strict',
    typeSymbol: `${RPC_TYPE}#${typeSymbol}`,
    schema: { parse: (v) => (guard ? guard(v) : v) },
  }
}
function pvRequireKey (v) {
  if (typeof v !== 'string' || !v) throw new Error('key must be a non-empty string')
  return v
}
function pvInvocations () {
  return [
    {
      id: `${RPC_TYPE}#${RPC_NAMESPACE}/getSummary`, service: RPC_SERVICE, namespace: RPC_NAMESPACE, method: 'getSummary',
      invocation: { kind: 'direct' }, parameters: [],
      result: pvCodec('Summary'),
    },
    {
      id: `${RPC_TYPE}#${RPC_NAMESPACE}/getSettings`, service: RPC_SERVICE, namespace: RPC_NAMESPACE, method: 'getSettings',
      invocation: { kind: 'direct' }, parameters: [],
      result: pvCodec('SettingsResult'),
    },
    {
      id: `${RPC_TYPE}#${RPC_NAMESPACE}/setSetting`, service: RPC_SERVICE, namespace: RPC_NAMESPACE, method: 'setSetting',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'key', wire: 'key', source: 'json', codec: pvCodec('SettingKey', pvRequireKey) },
        { name: 'value', wire: 'value', source: 'json', codec: pvCodec('SettingValue') },
      ],
      result: pvCodec('SetResult'),
    },
  ]
}
/** 宿主完整清单（ctx.typert.register 用）。 */
function pvHostManifest () {
  return {
    package: RPC_TYPE,
    face: 'host',
    schemas: [],
    invocations: pvInvocations(),
    model: {
      services: [{
        description: 'dsh-converge 收敛驾驶舱只读汇总与设置 RPC。Converge cockpit read-only summary & settings RPC.',
        summary: 'dsh-converge 设置/汇总服务 (dsh-converge summary & settings service)。',
        tags: [],
        jsDoc: '/** dsh-converge cockpit RPC service (ctx.convergeApi). */',
        key: RPC_SERVICE,
        exportName: 'ConvergeApiService',
        members: [
          { kind: 'method', name: 'getSummary', signature: 'getSummary(): object', summary: '只读汇总：阈值/权重/设置镜像。', jsDoc: '/** Read-only summary. */' },
          { kind: 'method', name: 'getSettings', signature: 'getSettings(): object', summary: '当前设置（内存 + 投影镜像）。', jsDoc: '/** Current settings. */' },
          { kind: 'method', name: 'setSetting', signature: 'setSetting(key: string, value: unknown): object', summary: '白名单设置项写入（内存 + converge/setting 事件）。', jsDoc: '/** Whitelisted setting write. */' },
        ],
        types: [],
      }],
      events: [],
      objects: [],
    },
  }
}
/** 客户端 $mount 清单（client bundle 内联同构副本）。 */
function pvClientManifest () {
  return { package: RPC_TYPE, descriptors: pvInvocations() }
}

export const pure = {
  jsonable, validateRef, evidenceKey, normalizePlan, defaultSlots, reduceEvent, replay, initialState, computeScore, pickSlot,
  isCurrentEvidence, gapKeyOf, buildGates, gateReport, GAP_CODES, REF_KINDS, STANCES, THRESHOLD, DEFAULT_CRITERIA,
  renderText,
  registerPure: {
    CONVERGE_EVENT_TYPES, PROBE_EVENT_TYPE, HOST_PKG_TARGETS, HOST_INSTALL_ROOTS,
    looksLikeJsEntry, candidatesFromPath, deriveRegisterCandidates, evaluateRegisterTarget, registerEventTypes,
  },
  pvPure: {
    PV_KEY, PV_STATE_VERSION, PV_TURN_CAP, pvPassthrough, pvInit, pvApply, pvView, pvDigest,
    pvHostManifest, pvClientManifest, pvInvocations,
    RPC_TYPE, RPC_SERVICE, RPC_NAMESPACE,
  },
}

// ---------------------------------------------------------------- 日志（自取证）

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNS_DIR = path.resolve(HERE, '..', '..', 'tests', 'runs')

function resolveLogPath () {
  const env = process.env.DSH_CONVERGE_LOG
  if (env) return path.isAbsolute(env) ? env : path.resolve(RUNS_DIR, env)
  return path.join(RUNS_DIR, `${process.env.DSH_CONVERGE_TAG || 'adhoc'}.log.jsonl`)
}

function makeLogger () {
  const file = resolveLogPath()
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch { /* 目录已存在 */ }
  const pid = process.pid
  const line = (ev, fields) => {
    try {
      const rec = jsonable({ t: new Date().toISOString(), ev, pid, ...fields }) ?? { t: new Date().toISOString(), ev, pid }
      fs.appendFileSync(file, JSON.stringify(rec) + '\n')
    } catch (e) { try { fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ev: 'log-error', pid, message: String(e && e.message || e) }) + '\n') } catch { /* 放弃 */ } }
  }
  return { file, line }
}

const safeGet = (ctx, name) => { try { return ctx.get(name) } catch { return undefined } }

/** 日志用的参数摘要：截断长字符串，避免把整段 verdictSummary 灌进 JSONL。 */
function shrink (value, depth = 0) {
  if (depth > 3) return '…'
  if (typeof value === 'string') return value.length > 120 ? value.slice(0, 117) + '…' : value
  if (Array.isArray(value)) return value.slice(0, 8).map((v) => shrink(v, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value).slice(0, 12)) out[k] = shrink(v, depth + 1)
    return out
  }
  return value
}

// ---------------------------------------------------------------- 插件主体

export async function apply (ctx) {
  const log = makeLogger()
  const states = new Map() // agentId -> 投影状态
  const disposers = []
  const caps = { deferContext: 'untested', steer: 'untested', followup: 'untested' }

  log.line('plugin-apply', { plugin: name, inject, logFile: log.file, node: process.version, tag: process.env.DSH_CONVERGE_TAG || 'adhoc' })

  // P3a：向宿主运行时注册 converge/* 事件类型（不注册的话，带这些事件的会话在官方
  // ctx.agents.resume 装载即拒，见上方注册面注释）。纯增量：await 完成于 apply 期内，
  // 因此 loader.await() 之后的一切 resume 都已在注册之后；任何失败只降级（记日志 +
  // ctx.logger.warn），本会话功能不受损。
  try {
    const reg = await registerEventTypes()
    log.line('event-types-register', reg)
    if (reg.outcome !== 'ok') {
      try {
        if (ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn(`dsh-converge: host event-type registration degraded (mode=${reg.mode}, candidates=${reg.candidateCount}); sessions containing converge/* events may refuse to resume`)
        }
      } catch { /* ctx 读不存在属性会抛（P0 实测），logger 形状不符就静默 */ }
    }
  } catch (e) {
    try { log.line('event-types-register', { outcome: 'degraded', mode: 'error', error: String((e && e.message) || e).slice(0, 200) }) } catch { /* 放弃 */ }
  }

  // BOOT 宿主探测（回答 P0 遗留 ⑤：web profile 下哪些宿主服务在场）。
  // 纪律：一律 ctx.get + try/catch，读不到就记 absent，绝不因为探测而炸插件树。
  try {
    const HOST_SERVICES = ['storageDomain', 'slots', 'webServer', 'sessionProjections', 'agents', 'sessions', 'sessionPersistence', 'goals', 'tools', 'systemPrompt', 'loader', 'sessions']
    const seen = new Set()
    const probe = {}
    for (const svc of HOST_SERVICES) {
      if (seen.has(svc)) continue
      seen.add(svc)
      let s
      try { s = ctx.get(svc) } catch (e) { probe[svc] = { present: false, threw: String((e && e.message) || e).slice(0, 100) }; continue }
      if (s === undefined || s === null) { probe[svc] = { present: false }; continue }
      const fns = new Set()
      try { for (const k of Object.getOwnPropertyNames(s)) { try { if (typeof s[k] === 'function') fns.add(k) } catch { /* getter 会抛，跳过 */ } } } catch { /* 不可枚举 */ }
      try { const proto = Object.getPrototypeOf(s); if (proto) for (const k of Object.getOwnPropertyNames(proto)) { if (k === 'constructor') continue; try { if (typeof s[k] === 'function') fns.add(k) } catch { /* 跳过 */ } } } catch { /* 无原型可读 */ }
      probe[svc] = { present: true, functions: [...fns].sort().slice(0, 14) }
    }
    log.line('host-services', {
      profile: process.env.DSH_PROFILE || process.env.DSH_CONVERGE_PROFILE || null,
      argv: process.argv.slice(1, 7),
      webPort: process.env.DSH_WEB_PORT || null,
      services: probe,
    })
    // P2.1（只加探测，不动门控/隔离/去重）：apply 期 ctx.get 拿不到某个服务，可能是该 profile
    // 真没挂，也可能只是 Cordis 还没构造它。等宿主起来之后再探一遍，才能把这两种情况分开。
    // LATE_EXTRA 是猜的服务名：命中就说明真实注册 id 与 BOOT 猜的不同。
    const LATE_EXTRA = ['webServer', 'server', 'httpServer', 'koa', 'storageDomain', 'storage', 'storageJson', 'slots', 'uiSlots', 'slotRegistry', 'sessionProjectionCache', 'projectionCache', 'goals', 'goal', 'goalDriver', 'goalRoundDriver', 'webFrontend', 'hostFrontend', 'sessionQuery', 'tokenMeter', 'settings', 'llm', 'models']
    const timer = setTimeout(() => {
      try {
        const late = {}
        for (const svc of [...new Set([...HOST_SERVICES, ...LATE_EXTRA])]) {
          let s
          try { s = ctx.get(svc) } catch (e) { late[svc] = { present: false, threw: String((e && e.message) || e).slice(0, 60) }; continue }
          if (s === undefined || s === null) { late[svc] = { present: false }; continue }
          const fns = new Set()
          try { for (const k of Object.getOwnPropertyNames(s)) { try { if (typeof s[k] === 'function') fns.add(k) } catch { /* getter 会抛 */ } } } catch { /* 不可枚举 */ }
          try { const proto = Object.getPrototypeOf(s); if (proto) for (const k of Object.getOwnPropertyNames(proto)) { if (k === 'constructor') continue; try { if (typeof s[k] === 'function') fns.add(k) } catch { /* 跳过 */ } } } catch { /* 无原型 */ }
          late[svc] = { present: true, functions: [...fns].sort().slice(0, 8) }
        }
        const absent = Object.entries(late).filter(([, v]) => !v.present).map(([k]) => k)
        log.line('host-services-late', { profile: process.env.DSH_PROFILE || process.env.DSH_CONVERGE_PROFILE || null, delayMs: 2500, absent, services: late })
      } catch (e) { log.line('host-services-late-failed', { message: String((e && e.message) || e).slice(0, 200) }) }
    }, 2500)
    if (typeof timer?.unref === 'function') timer.unref()
  } catch (e) { log.line('host-services-failed', { message: String((e && e.message) || e).slice(0, 200) }) }

  const tool = (def) => {
    ctx.tools.register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderText(value) }],
      },
      execute: async (args, exec) => {
        const agent = exec?.agent
        const key = String(agent?.id ?? 'unknown')
        let state = states.get(key)
        if (state === undefined) { state = replay(agent?.session?.events ?? []); states.set(key, state) }
        let out
        try {
          out = jsonable(await def.run({ args: args ?? {}, state, exec, agent, ctx })) ?? {}
        } catch (e) {
          log.line('tool-error', { tool: def.name, agent: key, message: String(e && e.message || e) })
          throw e
        }
        if (out.deferContextProbe !== undefined) caps.deferContext = out.deferContextProbe
        log.line('tool', {
          tool: def.name, agent: key, turn: exec?.turn,
          execKeys: exec && typeof exec === 'object' ? Object.keys(exec).sort() : null,
          execProto: exec && typeof exec === 'object' ? (Object.getOwnPropertyNames(Object.getPrototypeOf(exec) ?? {}) || []) : null,
          hasDeferContext: typeof exec?.deferContext,
          args: shrink(args),
          ok: out.blocked !== true,
          total: out.score?.total ?? out.total ?? null,
          gaps: (out.score?.gaps ?? out.gaps ?? []).length,
          nextBestAction: out.score?.nextBestAction ?? out.nextBestAction ?? '',
        })
        return out
      },
    })
  }

  // ---- 系统提示：让模型知道什么时候该用这些工具 ----
  try {
    ctx.systemPrompt.section({
      name: 'tool:converge',
      order: 116,
      text: [
        '<converge>',
        '你在一个"科研收敛驾驶舱"里做文献型任务。规则：',
        '1) 研究/综述类问题：先用 conv_plan 立一棵最小研究树（每个子问题至少 1 个必填支持槽 + 1 个反例槽），再随做随 conv_attach_evidence 记证据（doi/pmid/arxiv/zotero/url）。',
        '2) 收尾要过三道硬门（P2）：G1 引用门=每条已挂证据的 ref 都能解析（citationIntegrity=1，非法引用一票否决）；G2 结论门=每个已作答子问题都有 verdict；G3 收尾门=conv_conclude 的 verdictSummary 必须是非空正文。总分 < 0.85 或任一门没过时 conv_conclude 会被拦下并回 gateReport + 缺口 + 最短补法；照缺口补，或（确实补不动时）用 conv_mark_gap 记明原因。',
        '3) 反例检验不是可选项：每个已作答子问题要么有 stance=counter 的反例，要么有 conv_mark_gap 说明反例为何不可得。',
        '4) 引用 verified 目前只代表"格式合法、待联网核验"，不代表内容已核实。',
        '5) 证据按 treeVersion 隔离：conv_plan 重建树或 conv_add_subquestion 追加子问题会抬版本，旧版本证据不再计分；要把已知的引用按当前树重挂一次（同 kind+id 不会重复计分）。',
        '6) 纯闲聊/单步操作不要调用 conv_* 工具，插件对这些会话零打扰。回合末若被插入 <converge-check> 提醒，按其中的新增缺口补做；同一缺口只提醒一次。',
        '</converge>',
      ].join('\n'),
    })
    log.line('system-prompt-registered', {})
  } catch (e) { log.line('system-prompt-failed', { message: String(e && e.message || e) }) }

  // ---- P3b：会话 turn 追踪（写侧给 converge/* 事件盖 turn 戳，投影与 TurnTail 路由同一编号）----
  const turnTracker = new Map() // sessionKey / '__last__' -> 最近 turn 序号
  const recentAgentIds = [] // setSetting 落事件时找会话用
  let projectionRegistered = false
  let remoteMounted = false
  const noteTurn = (session, turn) => {
    try {
      const keys = [String(session?.id ?? ''), String(session?.sessionKey ?? ''), '__last__']
      for (const k of keys) if (k) turnTracker.set(k, turn)
    } catch { /* 追踪失败只影响 turn 戳，投影仍可用 turn/start 兜底 */ }
  }
  try {
    const off = ctx.on?.('session/event', (session, event) => {
      try {
        if (String(event?.type ?? '') === 'turn/start' && Number.isFinite(event?.data?.turn)) noteTurn(session, event.data.turn)
      } catch { /* 单事件失败不解除监听 */ }
    })
    if (typeof off === 'function') disposers.push(off)
    log.line('turn-tracker', { outcome: 'ok' })
  } catch (e) { log.line('turn-tracker', { outcome: 'degraded', error: String((e && e.message) || e) }) }
  const turnOf = (agent) => {
    const t = turnTracker.get(String(agent?.id ?? '')) ?? turnTracker.get(String(agent?.session?.id ?? '')) ?? turnTracker.get('__last__')
    return Number.isFinite(t) ? t : undefined
  }
  // 事件 turn 戳（加法）：已有 turn 字段的（turn-stopping 决策）不覆盖，这里只补工具写侧。
  const stampTurn = (agent, data) => {
    const t = turnOf(agent)
    if (t === undefined || (data && Object.prototype.hasOwnProperty.call(data, 'turn'))) return data
    return { ...(data ?? {}), turn: t }
  }

  // ---- P3b：会话投影 'converge'（宿主折叠一次，三块 UI 只读消费）----
  const registerProjection = () => {
    if (projectionRegistered) return
    let svc = null
    try { svc = ctx.get('sessionProjections') } catch { svc = null }
    if (!svc || typeof svc.register !== 'function') {
      log.line('projection-register', { outcome: 'degraded', reason: 'sessionProjections absent' })
      return
    }
    try {
      const dispose = svc.register({
        key: PV_KEY,
        stateVersion: PV_STATE_VERSION,
        stateSchema: pvPassthrough,
        schema: pvPassthrough,
        init: pvInit,
        apply: pvApply,
        view: pvView,
        // dsh 0.1.1-rc.1 起 wire 是向客户端推送的开关（cost-meter 注释实锤）；外层 schema/view 留给旧宿主，双写共存。
        wire: { viewSchema: pvPassthrough, view: pvView },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
      projectionRegistered = true
      log.line('projection-register', { outcome: 'ok', key: PV_KEY, stateVersion: PV_STATE_VERSION })
    } catch (e) {
      log.line('projection-register', { outcome: 'degraded', error: String((e && e.message) || e).slice(0, 300) })
    }
  }
  registerProjection()

  // ---- P3b：宿主设置（内存 + converge/setting 事件持久化；白名单外拒写）----
  const hostSettings = { 'notify.enabled': true }
  const SETTING_WHITELIST = {
    'notify.enabled': (v) => (typeof v === 'boolean' ? v : undefined),
  }
  const noteAgent = (id) => {
    const s = String(id ?? '')
    if (!s) return
    if (!recentAgentIds.includes(s)) recentAgentIds.push(s)
    if (recentAgentIds.length > 8) recentAgentIds.shift()
  }
  try { ctx.on?.('agent/created', (payload) => { try { noteAgent((payload?.agent ?? payload)?.id) } catch { /* 记录失败只影响 setSetting 找会话 */ } }) } catch { /* 无事件面就不记 */ }
  /**
   * 把设置变更追加成 converge/setting 事件（会话事件 = 既有持久化模式）；找不到活会话就只留内存。
   * N3：写入前必须过 stampTurn（与工具写侧同一回合打标机制）——之前这里只按全局 __last__ 兜底，
   * 没有 turn 时落 null，投影与 TurnTail 的回合归属就和工具事件两套口径。
   * 现在优先按目标会话自身的 turn 记录打标（turnOf 依次查 id / session.id / __last__），
   * 查不到就整字段缺省（宁缺不错），由投影侧的 turn/start 兜底归桶。
   */
  const persistSetting = (key, value) => {
    const base = { key, value, via: 'rpc' } // turn 由 stampTurn 追加，不在这里预置
    const tried = []
    try {
      const sessions = ctx.get('sessions')
      tried.push(`sessions=${sessions ? 'present' : 'absent'}`)
      const list = typeof sessions?.list === 'function' ? sessions.list() : null
      const target = Array.isArray(list) ? list.filter(Boolean).at(-1) : (list && typeof list.append === 'function' ? list : null)
      if (target && typeof target.append === 'function') {
        const data = jsonable(stampTurn(target, base))
        target.append('converge/setting', data)
        return { persisted: true, via: 'sessions.list', turn: data?.turn ?? null, tried }
      }
    } catch (e) { tried.push(`sessions-error=${String((e && e.message) || e).slice(0, 60)}`) }
    try {
      const agents = ctx.get('agents')
      tried.push(`agents=${agents ? 'present' : 'absent'}`)
      const last = recentAgentIds[recentAgentIds.length - 1]
      const agent = (last && typeof agents?.get === 'function') ? agents.get(last) : null
      if (agent?.session && typeof agent.session.append === 'function') {
        const data = jsonable(stampTurn(agent, base))
        agent.session.append('converge/setting', data)
        return { persisted: true, via: 'agents.get', turn: data?.turn ?? null, tried }
      }
    } catch (e) { tried.push(`agents-error=${String((e && e.message) || e).slice(0, 60)}`) }
    return { persisted: false, via: null, turn: null, tried }
  }

  // ---- P3b：convergeApi RPC（getSummary / getSettings / setSetting；手动 ctx.typert.register）----
  const convergeApi = {
    getSummary () {
      return jsonable({
        ok: true,
        plugin: name,
        projection: { key: PV_KEY, stateVersion: PV_STATE_VERSION, registered: projectionRegistered },
        settings: { ...hostSettings },
        policy: { threshold: THRESHOLD, weights: DEFAULT_CRITERIA, maxInjects: MAX_INJECTS_PER_SESSION },
        caps,
      }) ?? { ok: true }
    },
    getSettings () {
      return { ok: true, settings: { ...hostSettings }, whitelist: Object.keys(SETTING_WHITELIST) }
    },
    setSetting (key, value) {
      const k = String(key ?? '')
      const cast = SETTING_WHITELIST[k]
      if (!cast) return { ok: false, error: `key 不在白名单（可选：${Object.keys(SETTING_WHITELIST).join(', ')}）` }
      const v = cast(value)
      if (v === undefined) return { ok: false, error: `${k} 需要的值类型不匹配` }
      hostSettings[k] = v
      const p = persistSetting(k, v)
      // N3 证据面：turn=null 表示这条设置事件写不进任何回合（没有活会话/没有任何 turn/start），便于真机排查。
      try { log.line('setting-set', { key: k, value: v, persisted: p.persisted, via: p.via ?? null, turn: p.turn ?? null, tried: p.tried }) } catch { /* 日志失败不影响返回 */ }
      return { ok: true, key: k, value: v, persisted: p.persisted, turn: p.turn ?? null, settings: { ...hostSettings } }
    },
  }
  const mountRemote = () => {
    if (remoteMounted) return
    let typert = null
    try { typert = ctx.get('typert') } catch { typert = null }
    if (!typert || typeof typert.register !== 'function') {
      log.line('remote-mount', { outcome: 'degraded', reason: 'typert absent' })
      return
    }
    let provided = false
    try {
      // 网关 dispatch 校验 receiver.typertRemote === {service: original, serviceKey, namespace}（api-gateway 源码实锤）
      convergeApi.typertRemote = Object.freeze({ service: convergeApi, serviceKey: RPC_SERVICE, namespace: RPC_NAMESPACE })
      if (typeof ctx.provide === 'function') { ctx.provide(RPC_SERVICE, convergeApi); provided = true }
    } catch (e) {
      log.line('remote-mount', { outcome: 'degraded', stage: 'provide', error: String((e && e.message) || e).slice(0, 200) })
      return
    }
    try {
      const dispose = typert.register(pvHostManifest())
      if (typeof dispose === 'function') disposers.push(dispose)
      remoteMounted = true
      log.line('remote-mount', { outcome: 'ok', provided, methods: ['getSummary', 'getSettings', 'setSetting'] })
    } catch (e) {
      log.line('remote-mount', { outcome: 'degraded', stage: 'register', error: String((e && e.message) || e).slice(0, 300) })
    }
  }
  mountRemote()
  if (!projectionRegistered || !remoteMounted) {
    // BOOT 期服务缺席可能只是 Cordis 构造顺序（P2 的 late 探针就是为区分这两种情况）：2.5s 后补一次。
    const retry = setTimeout(() => {
      try {
        if (!projectionRegistered) registerProjection()
        if (!remoteMounted) mountRemote()
        log.line('p3b-late-retry', { projection: projectionRegistered, remote: remoteMounted })
      } catch { /* 补救失败维持 degraded */ }
    }, 2500)
    if (typeof retry?.unref === 'function') retry.unref()
  }

  // ---- 会话状态：agent 创建时对已有事件流重放（resume 场景） ----
  const agentOf = (payload) => payload?.agent ?? payload

  ctx.on('agent/created', (payload) => {
    const agent = agentOf(payload)
    if (!agent) return
    let events = []
    try { events = agent.session?.events ?? [] } catch { events = [] }
    const state = replay(events)
    states.set(String(agent.id), state)
    log.line('agent-created', {
      agent: String(agent.id),
      replayedConvergeEvents: events.filter((e) => String(e?.type || '').startsWith(EVENT_PREFIX)).length,
      hasPlan: !!state.plan,
      sessionApi: { append: typeof agent.session?.append, events: Array.isArray(agent.session?.events) ? 'array' : typeof agent.session?.events, steer: typeof agent.steer, followup: typeof agent.followup, inject: typeof agent.inject },
    })
  })

  // ---- 收尾拦截：turn 将结束时若未达标，就把"下一步指令"塞回模型（P2-C：按 gapKey 去重）----
  ctx.on('agent/turn-stopping', (payload) => {
    const agent = agentOf(payload)
    const key = String(agent?.id ?? 'unknown')
    const state = states.get(key)
    if (!agent || !state || !state.plan) { log.line('turn-stopping', { agent: key, action: 'skip-no-plan', hasPlan: !!state?.plan }); return }
    if (state.conclusion && state.conclusion.status !== 'blocked') { log.line('turn-stopping', { agent: key, action: 'skip-concluded', status: state.conclusion.status }); return }
    const sc = computeScore(state)
    if (sc.passing) { log.line('turn-stopping', { agent: key, action: 'skip-passing', total: sc.total }); return }
    const currentKeys = sc.gaps.map(gapKeyOf)
    const newKeys = currentKeys.filter((k) => !state.reminded.includes(k))
    const staleKeys = currentKeys.filter((k) => state.reminded.includes(k))
    if (!newKeys.length) {
      const data = jsonable({ action: 'dedup', turn: payload?.turn, total: sc.total, gateReport: gateReport(sc, { verdictSummary: 'x' }).filter((g) => !g.pass).map((g) => g.gate), skippedKeys: currentKeys, injects: state.injects, cap: MAX_INJECTS_PER_SESSION })
      try { agent.session?.append?.('converge/decision', data) } catch (e) { log.line('append-failed', { message: String(e && e.message || e) }) }
      reduceEvent(state, { type: 'converge/decision', seq: -1, time: Date.now(), data })
      log.line('turn-stopping', { agent: key, action: 'skip-dedup', total: sc.total, injects: state.injects, keys: currentKeys })
      return
    }
    if (state.injects >= MAX_INJECTS_PER_SESSION) {
      reduceEvent(state, { type: 'converge/decision', seq: -1, time: Date.now(), data: jsonable({ action: 'cap', turn: payload?.turn, total: sc.total }) })
      agent.session?.append?.('converge/decision', jsonable({ action: 'cap', turn: payload?.turn, total: sc.total, pendingKeys: newKeys, reason: `已达每会话最大提醒数 ${MAX_INJECTS_PER_SESSION}` }))
      log.line('turn-stopping', { agent: key, action: 'skip-cap', total: sc.total, injects: state.injects, pendingKeys: newKeys })
      return
    }
    const freshGaps = sc.gaps.filter((g) => newKeys.includes(gapKeyOf(g)))
    const text = renderSteer(sc, state, { gaps: freshGaps, staleKeys })
    const message = userMessage(text)
    let used = ''
    let error = ''
    try {
      if (typeof agent.steer === 'function') { agent.steer(message); used = 'steer' } else if (typeof agent.followup === 'function') { agent.followup(message); used = 'followup' } else { throw new Error('agent 上没有 steer/followup') }
    } catch (e) { error = String(e && e.message || e); used = 'failed' }
    caps.steer = used === 'steer' ? 'ok' : caps.steer
    caps.followup = used === 'followup' ? 'ok' : caps.followup
    const data = jsonable({
      action: used === 'steer' || used === 'followup' ? used : 'steer-failed',
      turn: payload?.turn, mechanism: used, total: sc.total, gapCount: sc.gaps.length,
      gapKeys: newKeys, dedupedKeys: staleKeys, gates: sc.blockingGates, error, cap: MAX_INJECTS_PER_SESSION,
    })
    try { agent.session?.append?.('converge/decision', data) } catch (e) { log.line('append-failed', { message: String(e && e.message || e) }) }
    reduceEvent(state, { type: 'converge/decision', seq: -1, time: Date.now(), data })
    log.line('inject', {
      agent: key, mechanism: used, turn: payload?.turn, total: sc.total, injects: state.injects, error,
      blockingGates: sc.blockingGates, nextBestAction: sc.nextBestAction,
      newGapKeys: newKeys, dedupedGapKeys: staleKeys,
      gaps: freshGaps.map((g) => g.code + ':' + String(g.detail).slice(0, 40)),
    })
  })

  // ------------------------------------------------------------ 7 个工具

  const requirePlan = (state) => { if (!state.plan) { const e = new Error('还没有研究树：先调用 conv_plan'); e.code = 'CONV_NO_PLAN'; throw e } }

  const appendPlan = (agent, state, plan, why) => {
    const treeVersion = (state.treeVersion ?? 0) + 1
    const data = jsonable(stampTurn(agent, { treeVersion, plan, why: why ?? '' }))
    agent.session.append('converge/plan', data)
    reduceEvent(state, { type: 'converge/plan', seq: -1, time: Date.now(), data })
    return treeVersion
  }

  tool({
    name: 'conv_plan',
    description: '建立（或整棵替换）研究树。触发条件：开始任何文献型/综述型研究任务时第一步就调它。subQuestions 每项 {id?, text, requiredSlots?}；requiredSlots 是必填支持槽数量（默认 1，另外自动补 1 个必填 counter 槽）。criteria 省略则用默认四件套 evidenceCoverage0.35/counterEvidence0.25/citationIntegrity0.25/synthesisCoverage0.15。',
    parameters: {
      type: 'object',
      properties: {
        researchQuestion: { type: 'string', description: '一句话研究问题' },
        subQuestions: {
          type: 'array',
          description: '子问题列表（1–6 条）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '可选稳定 id，默认 sq1/sq2…' },
              text: { type: 'string', description: '子问题（可检验的一句话）' },
              requiredSlots: { type: 'integer', description: '必填支持证据槽数量，默认 1' },
            },
            required: ['text'],
            additionalProperties: true,
          },
        },
        criteria: {
          type: 'array',
          description: '可选准则覆盖 [{id,kind,weight,target}]，kind ∈ evidenceCoverage/counterEvidence/citationIntegrity/synthesisCoverage',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['researchQuestion', 'subQuestions'],
      additionalProperties: false,
    },
    run: ({ args, state, agent }) => {
      const plan = normalizePlan(args)
      if (!plan.subQuestions.length) throw new Error('subQuestions 至少要有 1 条带 text 的子问题')
      const treeVersion = appendPlan(agent, state, plan, 'conv_plan')
      const sc = computeScore(state)
      return {
        ok: true, treeVersion,
        subQuestions: plan.subQuestions.map((sq) => ({ id: sq.id, text: sq.text.slice(0, 60), slots: sq.slots.map((s) => `${s.id}:${s.kind}${s.required ? '*' : ''}`) })),
        criteria: plan.criteria.map((c) => ({ kind: c.kind, weight: c.weight, target: c.target })),
        staleEvidence: sc.counts.staleEvidence,
        ...(sc.counts.staleEvidence ? { note: `treeVersion 抬到 ${treeVersion}：${sc.counts.staleEvidence} 条旧版本证据不再计分（P2-B 隔离），要用的话按当前树重挂一次` } : {}),
        total: sc.total, parts: sc.parts, blockingGates: sc.blockingGates, nextBestAction: sc.nextBestAction,
      }
    },
  })

  tool({
    name: 'conv_add_subquestion',
    description: '往当前研究树追加一个子问题（不新建树）。触发条件：打分后缺口显示"某方向完全没进树"，或用户追加了新要求。parentId 目前只作记录（扁平一层）。',
    parameters: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: '可选：挂在哪个子问题下（记录用）' },
        text: { type: 'string', description: '新子问题一句话' },
        requiredSlots: { type: 'integer', description: '必填支持槽数量，默认 1' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: ({ args, state, agent }) => {
      requirePlan(state)
      const plan = { ...state.plan, subQuestions: [...state.plan.subQuestions, { text: String(args.text), parentId: args.parentId ? String(args.parentId) : '', requiredSlots: args.requiredSlots ?? 1 }] }
      const normalized = normalizePlan(plan)
      const treeVersion = appendPlan(agent, state, normalized, 'conv_add_subquestion')
      const added = normalized.subQuestions[normalized.subQuestions.length - 1]
      const sc = computeScore(state)
      return {
        ok: true, treeVersion, addedId: added.id, subQuestionCount: normalized.subQuestions.length,
        total: sc.total, parts: sc.parts, blockingGates: sc.blockingGates,
        staleEvidence: sc.counts.staleEvidence,
        ...(sc.counts.staleEvidence ? { note: `追加子问题会抬 treeVersion：${sc.counts.staleEvidence} 条旧证据不再计分（新子问题与老槽位都要按当前树重挂）` } : {}),
        nextBestAction: sc.nextBestAction,
      }
    },
  })

  tool({
    name: 'conv_attach_evidence',
    description: '记录一条证据引用（事件溯源，同一树版本内同 kind+id 自动去重，重复挂不会虚增分数）。stance=counter 会自动落该子问题的 counter 槽（反例检验靠它）。slotId 可显式指定。换树（conv_plan / conv_add_subquestion）后旧版本证据不再计分：把同样的 kind+id 再挂一次即可在当前 treeVersion 下重新激活。注意：verified 只代表格式校验通过（DOI/PMID/arXiv/zotero/url 正则），不等于内容已联网核实。',
    parameters: {
      type: 'object',
      properties: {
        sqId: { type: 'string', description: '子问题 id（见 conv_plan / conv_status 返回）' },
        kind: { type: 'string', enum: REF_KINDS, description: '引用类型' },
        id: { type: 'string', description: '标识符：DOI 10.xxxx/后缀；PMID 数字；arXiv 2301.12345；zotero 8 位 key；url 完整链接' },
        stance: { type: 'string', enum: STANCES, description: 'supporting 支持 / counter 反例 / neutral 背景或方法' },
        locator: { type: 'string', description: '可选定位：章节/页码/段落' },
        note: { type: 'string', description: '可选：一句话说明这条证据支持/反对什么' },
        slotId: { type: 'string', description: '可选：显式落到哪个槽（省略则按 stance 自动落）' },
      },
      required: ['sqId', 'kind', 'id', 'stance'],
      additionalProperties: false,
    },
    run: ({ args, state, agent }) => {
      requirePlan(state)
      const sq = state.plan.subQuestions.find((s) => s.id === String(args.sqId))
      if (!sq) throw new Error(`未知 sqId "${args.sqId}"；当前子问题：${state.plan.subQuestions.map((s) => s.id).join(', ')}`)
      const stance = STANCES.includes(String(args.stance)) ? String(args.stance) : 'supporting'
      const check = validateRef(args.kind, args.id)
      const key = evidenceKey(args.kind, args.id)
      const treeVersion = state.treeVersion ?? 0
      const had = state.evidence.find((e) => e.key === key)
      if (had && isCurrentEvidence(had, treeVersion)) {
        return {
          ok: true, deduped: true, treeVersion, key,
          existing: { sqId: had.sqId, slotId: had.slotId, stance: had.ref?.stance },
          total: computeScore(state).total, note: '同一条引用在当前树版本已记录过，未重复计入分数',
        }
      }
      const taken = new Set(state.evidence.filter((e) => e.sqId === sq.id && isCurrentEvidence(e, treeVersion)).map((e) => e.slotId).filter(Boolean))
      let slotId = args.slotId ? String(args.slotId) : pickSlot(state.plan, sq.id, stance, taken)
      if (args.slotId && !(sq.slots ?? []).some((s) => s.id === slotId)) {
        return { ok: false, error: `槽 ${slotId} 不属于 ${sq.id}`, slots: (sq.slots ?? []).map((s) => `${s.id}:${s.kind}`), total: computeScore(state).total }
      }
      const ref = { kind: String(args.kind).toLowerCase(), id: normId(args.kind, args.id), stance, ...(args.locator ? { locator: String(args.locator) } : {}), ...(args.note ? { note: String(args.note) } : {}) }
      const data = jsonable(stampTurn(agent, { sqId: sq.id, slotId, ref, verified: check.ok, verifyReason: check.reason, key, treeVersion, verification: 'format-only（未联网核验）' }))
      agent.session.append('converge/evidence', data)
      reduceEvent(state, { type: 'converge/evidence', seq: -1, time: Date.now(), data })
      const sc = computeScore(state)
      return {
        ok: true, deduped: false, reactivated: !!had, key, treeVersion, sqId: sq.id, slotId: slotId || '(未落槽)',
        ...(had ? { note: '这条引用原先挂在旧 treeVersion，已在当前树版本重新激活' } : {}),
        verified: check.ok, formatCheck: check.ok ? '格式合法（待联网核验内容）' : check.reason,
        total: sc.total, parts: sc.parts, counts: sc.counts, blockingGates: sc.blockingGates, gates: sc.gates, nextBestAction: sc.nextBestAction,
      }
    },
  })

  tool({
    name: 'conv_mark_gap',
    description: '承认一个补不上的缺口（而不是让它悄悄拖着分数）。触发条件：找不到反例、引用待联网核验、访问受限、某子问题决定放弃。code 必须来自白名单；subquestion-dropped 会把该子问题移出分母。',
    parameters: {
      type: 'object',
      properties: {
        sqId: { type: 'string', description: '可选：属于哪个子问题（整树级缺口留空）' },
        code: { type: 'string', enum: GAP_CODES, description: '缺口类型（白名单）' },
        detail: { type: 'string', description: '一句话事实：查了什么、为什么补不上' },
      },
      required: ['code', 'detail'],
      additionalProperties: false,
    },
    run: ({ args, state, agent }) => {
      requirePlan(state)
      const code = GAP_CODES.includes(String(args.code)) ? String(args.code) : 'other'
      const sqId = args.sqId ? String(args.sqId) : ''
      if (sqId && !state.plan.subQuestions.some((s) => s.id === sqId)) throw new Error(`未知 sqId "${sqId}"`)
      const data = jsonable(stampTurn(agent, { sqId, code, detail: String(args.detail).slice(0, 300) }))
      agent.session.append('converge/gap', data)
      reduceEvent(state, { type: 'converge/gap', seq: -1, time: Date.now(), data })
      const sc = computeScore(state)
      return { ok: true, code, sqId, total: sc.total, parts: sc.parts, remainingGaps: sc.gaps.map((g) => g.code).slice(0, 8), nextBestAction: sc.nextBestAction }
    },
  })

  tool({
    name: 'conv_score',
    description: '只读打分（并落一条快照事件）：四项分 + 总分 + 具体缺口清单 + 每条缺口的最短补法 + nextBestAction。触发条件：想收尾之前、或补完一轮证据之后。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: ({ state, agent, exec }) => {
      requirePlan(state)
      const sc = computeScore(state)
      const data = jsonable(stampTurn(agent, { ...sc, gaps: sc.gaps, advice: sc.advice }))
      try { agent.session.append('converge/score', data) } catch (e) { /* 快照失败不影响打分 */ }
      const probe = typeof exec?.deferContext === 'function' ? 'available' : typeof exec === 'object' ? `missing(typeof=${typeof exec?.deferContext})` : 'no-exec'
      return {
        ok: true, total: sc.total, threshold: sc.threshold, passing: sc.passing, parts: sc.parts, weights: sc.weights,
        gates: sc.gates, blockingGates: sc.blockingGates, treeVersion: sc.treeVersion,
        counts: sc.counts, gaps: sc.gaps, advice: sc.advice, nextBestAction: sc.nextBestAction,
        verifiedIsFormatOnly: true, deferContextProbe: probe,
      }
    },
  })

  tool({
    name: 'conv_status',
    description: '只读看当前研究树 + 证据/缺口/verdict 摘要 + 最近分数（不写事件）。触发条件：忘了 sqId / 槽位 id，或想知道还剩什么。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: ({ state }) => {
      if (!state.plan) return { ok: true, hasPlan: false, hint: '先 conv_plan' }
      const sc = computeScore(state)
      const treeVersion = state.treeVersion ?? 0
      const cur = state.evidence.filter((e) => isCurrentEvidence(e, treeVersion))
      return {
        ok: true, hasPlan: true, treeVersion, researchQuestion: state.plan.researchQuestion,
        subQuestions: state.plan.subQuestions.map((sq) => ({
          id: sq.id, text: sq.text.slice(0, 60),
          slots: (sq.slots ?? []).map((s) => ({ id: s.id, kind: s.kind, required: !!s.required, filled: cur.some((e) => e.sqId === sq.id && e.slotId === s.id) })),
          evidence: state.evidence.filter((e) => e.sqId === sq.id).map((e) => `${e.ref.kind}:${String(e.ref.id).slice(0, 30)}(${e.ref.stance}${e.verified ? '' : ',非法'}${isCurrentEvidence(e, treeVersion) ? '' : ',旧版本已隔离'})`),
          verdict: state.verdicts.find((v) => v.sqId === sq.id)?.claim ?? null,
        })),
        gaps: state.gaps.map((g) => `${g.sqId || '-'}/${g.code}: ${String(g.detail).slice(0, 60)}`),
        conclusion: state.conclusion ? state.conclusion.status : 'none',
        intercepts: { injections: state.injects, cap: MAX_INJECTS_PER_SESSION, steer: state.steerCount, blocks: state.blocks, remindedGapKeys: state.reminded.length },
        total: sc.total, parts: sc.parts, passing: sc.passing, gates: sc.gates, blockingGates: sc.blockingGates,
        counts: sc.counts, nextBestAction: sc.nextBestAction,
      }
    },
  })

  tool({
    name: 'conv_conclude',
    description: '申请收尾。放行条件（P2 硬门控，三门全过且总分≥0.85）：G1 引用门=每条已挂证据的 ref 都可解析（citationIntegrity=1）；G2 结论门=每个已作答子问题都有 verdict（answered=0 视为通过）；G3 收尾门=verdictSummary 非空（空/缺省直接 reason:missing-verdict-summary）。任一不过 → 拦下并回 {blocked, gateReport, gaps, advice}。确实补不动时用 force:true + verdictSummary + residualGaps 明示缺口带 gap 收尾（记 converged-with-gaps）。verdicts 给每个已作答子问题一句话结论（G2 靠它）。',
    parameters: {
      type: 'object',
      properties: {
        verdictSummary: { type: 'string', description: '整体结论一段话（给用户看的那句人话）' },
        verdicts: {
          type: 'array', description: '逐子问题结论 [{sqId, claim, confidence?}]（confidence 0–1，默认 0.7）',
          items: { type: 'object', properties: { sqId: { type: 'string' }, claim: { type: 'string' }, confidence: { type: 'number' } }, required: ['sqId', 'claim'], additionalProperties: false },
        },
        residualGaps: {
          type: 'array', description: 'force 收尾时必填：仍然存在的缺口 [{sqId?, code, detail}]（code 用白名单）',
          items: { type: 'object', properties: { sqId: { type: 'string' }, code: { type: 'string' }, detail: { type: 'string' } }, required: ['code', 'detail'], additionalProperties: false },
        },
        force: { type: 'boolean', description: '未达标也要收尾（必须同时给 residualGaps）' },
      },
      required: ['verdictSummary'],
      additionalProperties: false,
    },
    run: ({ args, state, agent, exec }) => {
      requirePlan(state)
      // G3 收尾门（P2-A）：verdictSummary 为空/缺省 → 直接拒，且不动任何状态
      if (!String(args.verdictSummary ?? '').trim()) {
        const sc0 = computeScore(state)
        const report = gateReport(sc0, args)
        const data = jsonable({ action: 'block', reason: 'missing-verdict-summary', total: sc0.total, gates: report.filter((g) => !g.pass).map((g) => g.gate) })
        try { agent.session?.append?.('converge/decision', data) } catch (e) { log.line('append-failed', { where: 'g3', message: String(e && e.message || e) }) }
        reduceEvent(state, { type: 'converge/decision', seq: -1, time: Date.now(), data })
        return {
          blocked: true, converged: false, reason: 'missing-verdict-summary', gateReport: report,
          score: { total: sc0.total, parts: sc0.parts, threshold: sc0.threshold, counts: sc0.counts },
          note: 'G3 收尾门：conv_conclude 必须带 verdictSummary —— 给用户看的那段结论正文，即使分数达标也不能空着收尾。补齐 verdictSummary（以及逐子问题 verdicts）再来。',
        }
      }
      // 1) 先吸收 verdicts / residualGaps，再打分（让"补了就认"成立）
      for (const v of Array.isArray(args.verdicts) ? args.verdicts : []) {
        if (!v || !state.plan.subQuestions.some((s) => s.id === String(v.sqId))) continue
        const data = jsonable(stampTurn(agent, { sqId: String(v.sqId), claim: String(v.claim ?? '').slice(0, 300), confidence: typeof v.confidence === 'number' ? Math.max(0, Math.min(1, v.confidence)) : 0.7, from: 'conv_conclude' }))
        agent.session.append('converge/verdict', data)
        reduceEvent(state, { type: 'converge/verdict', seq: -1, time: Date.now(), data })
      }
      for (const g of Array.isArray(args.residualGaps) ? args.residualGaps : []) {
        if (!g || !g.code) continue
        const code = GAP_CODES.includes(String(g.code)) ? String(g.code) : 'other'
        const data = jsonable(stampTurn(agent, { sqId: g.sqId ? String(g.sqId) : '', code, detail: String(g.detail ?? '').slice(0, 300), from: 'residualGaps' }))
        agent.session.append('converge/gap', data)
        reduceEvent(state, { type: 'converge/gap', seq: -1, time: Date.now(), data })
      }
      const sc = computeScore(state)
      const force = args.force === true

      if (!sc.passing && !force) {
        const report = gateReport(sc, args)
        const failed = report.filter((g) => !g.pass)
        const data = jsonable(stampTurn(agent, { status: 'blocked', score: { total: sc.total, parts: sc.parts }, gapCount: sc.gaps.length, gates: failed.map((g) => g.gate) }))
        try { agent.session.append('converge/conclude', data) } catch (e) { /* 忽略快照失败 */ }
        reduceEvent(state, { type: 'converge/conclude', seq: -1, time: Date.now(), data })
        const data2 = jsonable(stampTurn(agent, { action: 'block', total: sc.total, gapCount: sc.gaps.length, gates: failed.map((g) => g.gate) }))
        try { agent.session.append('converge/decision', data2) } catch (e) { /* 忽略 */ }
        reduceEvent(state, { type: 'converge/decision', seq: -1, time: Date.now(), data: data2 })
        // 顺带试一次 exec.deferContext（下一 step 注入指令）；不可用就只靠返回值 + turn-stopping
        let defer = 'not-attempted'
        try {
          if (typeof exec?.deferContext === 'function') { exec.deferContext(userMessage(renderSteer(sc, state, { gaps: sc.gaps, staleKeys: [] }))); defer = 'called' } else defer = `unavailable(typeof=${typeof exec?.deferContext})`
        } catch (e) { defer = `threw: ${String((e && e.message) || e).slice(0, 80)}` }
        caps.deferContext = defer
        return {
          blocked: true, converged: false,
          score: { total: sc.total, parts: sc.parts, threshold: sc.threshold, counts: sc.counts },
          gateReport: report, blockingGates: sc.blockingGates,
          gaps: sc.gaps, advice: sc.advice, nextBestAction: sc.nextBestAction,
          deferContext: defer,
          note: `未达标：需要总分≥${sc.threshold} 且 G1 引用门 / G2 结论门 / G3 收尾门全过（当前没过的是 ${failed.map((g) => g.gate + ' ' + g.name).join('、') || '（分数不足）'}）。按 gateReport 与 advice 补完再调 conv_conclude；确实补不动就 conv_conclude {force:true, verdictSummary:"...", residualGaps:[...]} 明示缺口带 gap 收尾。`,
        }
      }

      if (!sc.passing && force && !(Array.isArray(args.residualGaps) && args.residualGaps.length)) {
        return {
          blocked: true, converged: false, gateReport: gateReport(sc, args),
          error: 'force:true 收尾必须同时明示 residualGaps（至少 1 条，含 code 与 detail）', score: { total: sc.total, parts: sc.parts }, gaps: sc.gaps, advice: sc.advice,
        }
      }

      const status = sc.passing ? 'converged' : 'converged-with-gaps'
      const report = gateReport(sc, args)
      const data = jsonable(stampTurn(agent, {
        status, score: { total: sc.total, parts: sc.parts }, gatesPassed: report.filter((g) => g.pass).map((g) => g.gate), gatesWaived: status === 'converged-with-gaps' ? sc.blockingGates : [],
        verdictSummary: String(args.verdictSummary ?? '').slice(0, 800),
        residualGaps: (Array.isArray(args.residualGaps) ? args.residualGaps : []).map((g) => ({ sqId: g?.sqId ?? '', code: g?.code ?? 'other', detail: String(g?.detail ?? '').slice(0, 200) })),
      }))
      agent.session.append('converge/conclude', data)
      reduceEvent(state, { type: 'converge/conclude', seq: -1, time: Date.now(), data })
      return {
        blocked: false, converged: true, status, gateReport: report,
        score: { total: sc.total, parts: sc.parts, counts: sc.counts },
        residualGaps: data.residualGaps ?? [],
        ...(status === 'converged-with-gaps' ? { residualGates: sc.blockingGates, note: `带缺口收尾：三道门没过 [${sc.blockingGates.join(', ')}]，已按 residualGaps 明示（P2 允许明示缺口带 gap 收尾，但会话记录里是 converged-with-gaps，不是 converged）` } : {}),
      }
    },
  })

  log.line('tools-registered', {
    count: 7,
    services: { tools: typeof ctx.tools, systemPrompt: typeof ctx.systemPrompt, agents: typeof safeGet(ctx, 'agents'), sessions: typeof safeGet(ctx, 'sessions') },
    inject: [...inject],
  })

  const dispose = () => {
    try { log.line('plugin-dispose', { sessions: states.size, caps }) } catch { /* 忽略 */ }
    for (const d of disposers) { try { d() } catch { /* 忽略 */ } }
  }
  return dispose
}

// ---------------------------------------------------------------- 小工具（非纯函数）

/** 工具返回值的模型可见文本：先人话摘要，再附结构化 JSON（截断防刷屏）。 */
function renderText (value) {
  if (value === null || typeof value !== 'object') return String(value)
  const lines = []
  const score = value.score && typeof value.score === 'object' ? value.score : null
  const total = score?.total ?? value.total
  if (value.blocked === true) lines.push(`CONVERGE 拦截：收敛分 ${fmt(total)}（阈值 ${fmt(score?.threshold ?? 0.85)}）${value.error ? '· ' + value.error : ''}`)
  else if (value.status) lines.push(`CONVERGE ${value.status}：收敛分 ${fmt(total)}`)
  else if (typeof total === 'number') lines.push(`CONVERGE 收敛分 ${fmt(total)}${value.passing === undefined ? '' : value.passing ? '（达标）' : '（未达标）'}`)
  if (value.parts) lines.push(`四项：${Object.entries(value.parts).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')}`)
  if (value.reason === 'missing-verdict-summary') lines.push('G3 收尾门没过：conv_conclude 必须带非空 verdictSummary（给用户看的结论正文）')
  if (Array.isArray(value.gateReport)) {
    const failed = value.gateReport.filter((g) => !g.pass)
    const passed = value.gateReport.filter((g) => g.pass).map((g) => g.gate)
    if (failed.length) {
      lines.push(`硬门未过 ${failed.map((g) => `${g.gate}(${g.name})`).join(' ')}${passed.length ? ` ｜ 已过 ${passed.join(' ')}` : ''}：`)
      for (const g of failed) for (const r of (g.reasons.length ? g.reasons : ['未通过'])) lines.push(`  ✗ [${g.gate} ${g.name}] ${r}`)
    } else if (value.gatesPassed) lines.push(`硬门全过：${(value.gateReport ?? []).map((g) => g.gate).join(' ')}`)
  }
  if (Array.isArray(value.residualGates) && value.residualGates.length) lines.push(`带缺口收尾：明示放弃的门 ${value.residualGates.join(' ')}`)
  if (value.deduped) lines.push('这条引用在当前树版本已记录过（同 kind+id 去重，未重复计分）')
  if (value.reactivated) lines.push('这条引用原先挂在旧 treeVersion，已在当前树版本重新激活')
  if (typeof value.staleEvidence === 'number' && value.staleEvidence > 0) lines.push(`旧 treeVersion 证据 ${value.staleEvidence} 条已隔离（不计分）`)
  if (Array.isArray(value.gaps) && value.gaps.length) {
    lines.push('缺口：')
    // gaps 有两种形状：打分器给的是 {sqId,code,detail} 对象，conv_status 给的是已经排好序的字符串。
    // 真机（跨会话恢复腿）暴露过这里：只按对象读 → 渲染成 "[undefined] undefined"。两种都要能显示。
    for (const [i, g] of value.gaps.entries()) {
      lines.push(typeof g === 'string' ? `  ${i + 1}. ${g}` : `  ${i + 1}. [${g?.code ?? '?'}] ${g?.sqId ? g.sqId + ' ' : ''}${g?.detail ?? ''}`)
    }
  }
  if (Array.isArray(value.advice) && value.advice.length) {
    lines.push('最短补法：')
    for (const [i, a] of value.advice.entries()) lines.push(`  ${i + 1}. ${a}`)
  }
  if (value.nextBestAction) lines.push(`nextBestAction: ${value.nextBestAction}`)
  let json = ''
  try {
    json = JSON.stringify(value)
    if (json.length > 1800) json = json.slice(0, 1800) + '…(truncated)'
  } catch { json = '{unserializable}' }
  return `${lines.join('\n')}\n${json}`
}

function fmt (n) { return typeof n === 'number' ? n.toFixed(2) : String(n) }

function userMessage (text) {  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return { role: 'user', id, content: [{ type: 'text', text: String(text) }], source: { kind: 'plugin', plugin: 'dsh-converge' } }
}

function renderSteer (sc, state, opts = {}) {
  const gaps = Array.isArray(opts.gaps) ? opts.gaps : sc.gaps
  const staleKeys = Array.isArray(opts.staleKeys) ? opts.staleKeys : []
  const failed = (sc.gates ?? []).filter((g) => !g.pass)
  const lines = [
    `<converge-check>本轮收尾被拦：收敛分 ${sc.total.toFixed(2)}（阈值 ${sc.threshold}），硬门没过：${failed.length ? failed.map((g) => `${g.gate} ${g.name}`).join('、') : '（三道门已过，是分数不够）'}。`,
    `四项：证据覆盖 ${sc.parts.evidenceCoverage}（已填 ${sc.counts.filledSlots}/${sc.counts.requiredSlots} 必填槽）· 反例 ${sc.parts.counterEvidence}（${sc.counts.counterOk}/${sc.counts.answered} 个已作答子问题有已核验反例）· 引用合法 ${sc.parts.citationIntegrity}（${sc.counts.unresolvedInvalidRefs} 条不可解析${sc.counts.staleEvidence ? `，另有 ${sc.counts.staleEvidence} 条旧 treeVersion 证据被隔离` : ''}）· 综合 ${sc.parts.synthesisCoverage}（${sc.counts.verdicts}/${sc.counts.answered} 有 verdict）。`,
    ...(failed.some((g) => g.reasons.length) ? ['门控失败原因：', ...failed.flatMap((g) => g.reasons.map((r) => `  · [${g.gate} ${g.name}] ${r}`))] : []),
    `本轮新增缺口（同一缺口本会话只提醒一次，已提醒过的不再重复）：`,
    ...gaps.slice(0, 6).map((g, i) => `  ${i + 1}. [${g.code}] ${g.detail}`),
    ...(gaps.length ? ['最短补法：', ...gaps.slice(0, 4).map((g, i) => `  ${i + 1}. ${g.fix ?? g.detail}`)] : []),
    `nextBestAction: ${sc.nextBestAction}`,
    `（本会话第 ${state.injects + 1}/${MAX_INJECTS_PER_SESSION} 次提醒${staleKeys.length ? `，另有 ${staleKeys.length} 类旧缺口已提醒过被去重` : ''}。补不动了就 conv_mark_gap 记明原因，或 conv_conclude {force:true, verdictSummary:"...", residualGaps:[...]} 明示缺口带 gap 收尾；本提醒不再重复。）</converge-check>`,
  ]
  return lines.join('\n')
}
