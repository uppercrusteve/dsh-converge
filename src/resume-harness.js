// dsh-converge P2 / T9 取证 harness：验证「跨会话复原」——用 session id 续接一个已有会话，
// 让模型自己调 conv_status 复述研究树，并把「事件重放出来的分数」与「会话内实时分数」对表。
//
// 为什么需要它：`dsh --profile headless "<task>"` 的 runner 永远新建会话
// （sessionId = 'session-' + randomUUID()），CLI 层没有 --resume 续会话参数
// （只有启动器 help 里的 `--profile tui --resume <session>` 示例，headless app 只声明 [task...]）。
// 恢复入口是 core 服务：ctx.agents.resume({ resumeSessionId })，它内部会走 sessionPersistence.prepare →
// setupAndPublish(…"resume")，也就是把磁盘上的 session 事件流重新装载成内存投影。
// 本 harness 就调这个公开 API，然后：
//   A) 纯重放核对：把恢复出来的事件流交给 converge.js 的 pure.replay/computeScore（不问模型）
//   B) 活会话核对：followup 一句「只调 conv_status 复述」，等 idle，再从事件流里把工具结果摘出来
// 纪律：不 import npm 包（只用 node: 内置 + ctx API）；inject 留空；一切读 ctx 都 try/catch。
export const name = 'dsh-converge-resume-harness'
export const inject = []

const CONV_URL = 'file:///D:/codingspace/labs/dsh-converge/plugin/src/converge.js'

function short (e) { return String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 400) }

export async function apply (ctx) {
  const sid = process.env.DSH_CONVERGE_RESUME || ''
  const logFile = process.env.DSH_CONVERGE_HARNESS_LOG || 'D:\\codingspace\\labs\\dsh-converge\\tests\\runs\\T9.harness.log.jsonl'
  let fsMod = null
  try { fsMod = await import('node:fs') } catch (e) { return }
  const line = (ev, fields) => {
    try {
      const rec = { t: new Date().toISOString(), pid: process.pid, ev, ...(fields || {}) }
      fsMod.appendFileSync(logFile, JSON.stringify(rec) + '\n')
    } catch { /* 日志失败不影响宿主 */ }
  }
  line('harness-apply', {
    resumeSessionId: sid || null,
    harnessLog: logFile,
    argv: process.argv.slice(1, 7),
    envKeys: Object.keys(process.env).filter((k) => /^DSH_CONVERGE/.test(k)).sort(),
  })
  if (!sid) { line('harness-skip', { reason: 'DSH_CONVERGE_RESUME 未设置：harness 不做任何事' }); return }

  const run = async () => {
    const loader = ctx.get('loader')
    if (loader?.await) { try { await loader.await() } catch (e) { line('loader-await-threw', { error: short(e) }) } }
    const agents = ctx.get('agents')
    line('services', {
      agents: typeof agents,
      hasResume: typeof agents?.resume,
      sessionPersistence: typeof ctx.get('sessionPersistence'),
      sessions: typeof ctx.get('sessions'),
      appExit: typeof ctx.get('appExit'),
    })
    if (typeof agents?.resume !== 'function') throw new Error('ctx.agents.resume 不可用，无法续会话')

    // P3a 起：converge/* 的宿主注册职责已上移到 converge.js 的 apply（registerEventTypes，日志 ev:event-types-register）。
    // 下面这段退役为**可选 fallback**：默认跳过（日志 ev:catalog-register-skip 说明去向）；只有设
    // DSH_CONVERGE_HARNESS_REGISTER=1 才在这里再注册一遍（Set.add 幂等），用于对照实验。
    // T9 这条腿的本职是取证（resume 成败、重放分对表）：注册必须默认缺席，才能证明 ok 是插件自己干的。
    // （历史背景 P2.1：官方读盘路径 dsh-session-persistence 会拒绝包含"本 build 不认识的事件类型"的会话
    //  `unknown to this harness and not marked ignorable`；session.append() 又没有传 ignorable 的口子；
    //  known-event-types.js 注释说明下游插件事件的注册面"推迟到出现这样的消费者再说"。）
    if (process.env.DSH_CONVERGE_HARNESS_REGISTER === '1') {
    try {
      const { pathToFileURL } = await import('node:url')
      const p = await import('node:path')
      const bin = process.argv[1] || ''
      const base = bin ? p.resolve(p.dirname(bin), '..', '..', '..') : ''
      const candidates = [
        base && pathToFileURL(p.join(base, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href,
        base && pathToFileURL(p.join(base, '@deepseek-ai', 'dsh-session', 'lib', 'types', 'known-event-types.js')).href,
      ].filter(Boolean)
      const CONV_TYPES = ['converge/plan', 'converge/evidence', 'converge/gap', 'converge/verdict', 'converge/score', 'converge/conclude', 'converge/decision']
      const hits = []
      for (const url of candidates) {
        let mod = null
        try { mod = await import(url) } catch (e) { hits.push({ url, ok: false, error: short(e) }); continue }
        const set = mod?.KNOWN_SESSION_EVENT_TYPES
        if (!set || typeof set.add !== 'function' || typeof set.has !== 'function') { hits.push({ url, ok: false, error: '该模块没有可读写的 KNOWN_SESSION_EVENT_TYPES' }); continue }
        const before = CONV_TYPES.filter((t) => set.has(t)).length
        for (const t of CONV_TYPES) set.add(t)
        hits.push({ url, ok: true, size: set.size, alreadyRegistered: before, added: CONV_TYPES.length - before, verifiedAll: CONV_TYPES.every((t) => set.has(t)) })
      }
      line('catalog-register', { why: 'persistence 读盘拒绝未知事件类型', derivedFromBin: bin, attempts: hits })
    } catch (e) { line('catalog-register-failed', { error: short(e) }) }
    } else {
      line('catalog-register-skip', { why: 'P3a: registration lives in converge.js apply (see plugin log ev:event-types-register); set DSH_CONVERGE_HARNESS_REGISTER=1 to re-run this fallback' })
    }

    const dm = ctx.get('agentDefaultModel')
    let sel = null
    try { sel = dm?.currentSelection?.() ?? null } catch (e) { line('default-model-threw', { error: short(e) }) }
    line('resume-begin', { sessionId: sid, model: sel })
    const handle = await agents.resume({ resumeSessionId: sid, ...(sel ? { agentOptions: { provider: sel.provider, model: sel.model } } : {}) })
    const agent = handle?.agent ?? handle
    const events = (() => { try { return agent?.session?.events ?? [] } catch { return [] } })()
    line('resume-ok', {
      agentId: String(agent?.id ?? ''),
      headerId: String(agent?.session?.header?.id ?? ''),
      requestedSid: sid,
      idMatchesRequested: String(agent?.id ?? '') === sid || String(agent?.session?.header?.id ?? '') === sid,
      eventCount: events.length,
      hasWhenIdle: typeof agent?.whenIdle,
      hasFollowup: typeof agent?.followup,
    })

    // A) 纯重放核对（不问模型）：恢复出来的事件流 should 直接重放出原来的树和分数
    try {
      const conv = await import(CONV_URL)
      const st = conv.pure.replay(events)
      const sc = conv.pure.computeScore(st)
      line('replay-check', {
        treeVersion: st.treeVersion,
        hasPlan: !!st.plan,
        subQuestions: st.plan?.subQuestions?.length ?? 0,
        evidence: st.evidence.length,
        verdicts: st.verdicts.length,
        conclusion: st.conclusion?.status ?? null,
        reminded: st.reminded.length,
        total: sc.total,
        parts: sc.parts,
        passing: sc.passing,
        blockingGates: sc.blockingGates,
        injects: st.injects,
      })
    } catch (e) { line('replay-check-failed', { error: short(e) }) }

    // B) 让模型自己调 conv_status 复述（证明恢复出来的工具状态是活的，不只是磁盘事件流）
    const prompt = process.env.DSH_CONVERGE_RESUME_PROMPT
      || '只调用一次 conv_status 工具（不要调用其它 conv_* 工具，不要新增证据），然后用中文一到三句话复述：研究树里有几个子问题、每个子问题的必填槽是否已填、当前总分与是否达标。'
    if (typeof agent?.followup === 'function') {
      const id = globalThis.crypto?.randomUUID?.() ?? String(Date.now())
      agent.followup({ role: 'user', id, content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
      line('followup-sent', { prompt: prompt.slice(0, 120) })
      if (typeof agent.whenIdle === 'function') { await agent.whenIdle(); line('agent-idle', {}) } else line('no-whenIdle', {})
    } else line('no-followup', { typeofFollowup: typeof agent?.followup })

    // C) 事后取证：会话内实时 conv_status 的返回 + 重放分对表 + 注入/提醒痕迹
    try {
      const conv = await import(CONV_URL)
      const eventsNow = (() => { try { return agent?.session?.events ?? [] } catch { return [] } })()
      const st = conv.pure.replay(eventsNow)
      const sc = conv.pure.computeScore(st)
      const statusResults = []
      let injectedSeen = 0
      for (const e of eventsNow) {
        const s = JSON.stringify(e?.data ?? {})
        if (/"conv_status"/.test(s) && /"tool/.test(String(e?.type))) statusResults.push({ seq: e?.seq, type: e?.type, size: s.length, sample: s.slice(0, 900) })
        if (/"plugin":"dsh-converge"/.test(s)) injectedSeen += 1
      }
      line('live-status-results', { count: statusResults.length })
      for (const r of statusResults.slice(-3)) line('live-status-sample', r)
      line('final-replay', {
        eventCount: eventsNow.length,
        total: sc.total,
        parts: sc.parts,
        passing: sc.passing,
        blockingGates: sc.blockingGates,
        subQuestions: st.plan?.subQuestions?.length ?? 0,
        evidence: st.evidence.length,
        evidenceCurrent: sc.counts.evidenceCurrent,
        staleEvidence: sc.counts.staleEvidence,
        verdicts: st.verdicts.length,
        conclusion: st.conclusion?.status ?? null,
        pluginTaggedEvents: injectedSeen,
      })
      // 模型可见性核对：conv_status 的工具结果进没进模型上下文（数最后一条 request/* 里有没有 conv_status）
      let lastReq = null
      for (const e of eventsNow) if (String(e?.type || '').startsWith('request/')) lastReq = e
      if (lastReq) {
        const s = JSON.stringify(lastReq?.data ?? {})
        line('model-context-probe', { reqType: lastReq.type, mentionsConvStatus: /conv_status/.test(s), mentionsConvergeCheck: /converge-check/.test(s), size: s.length })
      } else line('model-context-probe', { reqType: null })
    } catch (e) { line('post-forensics-failed', { error: short(e) }) }

    line('harness-done', { sessionId: sid })
    try {
      const sessions = ctx.get('sessions')
      if (typeof sessions?.flush === 'function' && agent?.session) await sessions.flush(agent.session)
      line('session-flushed', {})
    } catch (e) { line('session-flush-failed', { error: short(e) }) }
    const exit = ctx.get('appExit')
    if (typeof exit === 'function') { line('requesting-exit', { code: 0 }); exit(0) } else line('no-appExit', {})
  }

  run().catch((e) => line('harness-error', {
    message: short(e),
    stack: String((e && e.stack) || '').split('\n').slice(0, 6).join(' | ').slice(0, 600),
  }))
}
