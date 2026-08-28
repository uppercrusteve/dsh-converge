// dsh-converge P0 probe plugin, v3.
// No npm imports: node builtins + Cordis ctx API only.
// Fixes v2 bugs: (1) safeGet/safe confusion (descriptor vs value),
// (2) ctx.emit passes MULTIPLE args — the 'session/event' payload is the live
// session object, not an event, so capture every argument.
import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-converge-probe'
const INJECT = process.env.DSH_PROBE_INJECT ? JSON.parse(process.env.DSH_PROBE_INJECT) : []
export const inject = INJECT

const OUT_DIR = 'D:\\codingspace\\labs\\dsh-converge\\probe'
const OUT = path.join(OUT_DIR, 'probe-report.json')

const short = (e) => String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 400)
const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
function desc (o, k) { try { const v = o[k]; return { ok: true, type: kindOf(v), value: v } } catch (e) { return { ok: false, error: short(e) } } }
function val (o, k) { const d = desc(o, k); return d.ok ? d.value : undefined }

const R = {
  meta: { plugin: 'dsh-converge-probe', v: 3, startedAt: new Date().toISOString(), node: process.version, pid: process.pid,
    DSH_HOME_env: process.env.DSH_HOME ?? null, injectDeclared: INJECT, argv: process.argv.slice(2) },
  apply: {}, eventArgShapes: [], sessionEventTypeCounts: {}, sessionEventSamples: {},
  lazyServices: {}, events: [], fired: {}, agent: null,
  agentScoped: [], goalsProbe: [], revisionProbe: [], appendProbe: [], writeApiHunt: [],
  errors: [], timeline: [],
}

let writes = 0
function flush (tag) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    R.meta.flushes = ++writes; R.meta.flushedAt = new Date().toISOString()
    if (tag) R.timeline.push(tag + '@' + new Date().toISOString())
    fs.writeFileSync(OUT + '.tmp', JSON.stringify(R, null, 2))
    fs.renameSync(OUT + '.tmp', OUT)
  } catch (e) { R.errors.push({ where: 'flush', error: short(e) }) }
}

const NAMES = ['goals', 'agents', 'sessions', 'sessionEvents', 'storageDomain', 'sessionProjections',
  'schedule', 'subagents', 'workflowEngine', 'sandbox', 'approval', 'slots', 'settings', 'webServer',
  'tools', 'systemPrompt', 'commands', 'jobs', 'skills', 'credentials', 'sessionProjection']
function sweep () {
  const out = {}
  for (const n of NAMES) {
    try {
      const s = ctx.get(n)
      if (s === undefined || s === null) { out[n] = { present: false }; continue }
      // collect method names without letting a throwing getter poison the result
      const names = new Set()
      try { for (const k of Object.getOwnPropertyNames(s)) names.add(k) } catch {}
      try { for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(s) || {})) names.add(k) } catch {}
      const fns = []
      for (const k of names) { if (k.startsWith('_') || k === 'constructor') continue; let t; try { t = typeof s[k] } catch { continue } if (t === 'function') fns.push(k) }
      out[n] = { present: true, functions: fns.sort() }
    } catch (e) { out[n] = { present: false, threw: true, error: short(e) } }
  }
  return out
}

let ctx = null

export async function apply (theCtx) {
  ctx = theCtx
  R.apply.enteredAt = new Date().toISOString()
  for (const k of ['get', 'on', 'effect', 'inject', 'root', 'plugin', 'logger', 'options', 'sessions', 'agentEvents']) {
    const d = desc(theCtx, k); R.apply['has_' + k] = d.ok ? 'readable:' + d.type : 'THROWS:' + d.error
  }
  R.apply.applyTimeGetGoals = (() => { try { const s = theCtx.get('goals'); return s ? 'present' : String(s) } catch (e) { return 'THROWS:' + short(e) } })()
  flush('apply-entered')

  const disposers = []
  for (const type of ['agent/created', 'session/event', 'goal/change', 'goal/changed', 'agent/turn-stopping']) {
    const rec = { type }
    try {
      const d = theCtx.on(type, (...args) => {
        R.fired[type] = (R.fired[type] || 0) + 1
        if (type === 'session/event') onSessionEvent(args)
        if (type === 'agent/created') queueMicrotask(() => onAgent(args).catch((e) => { R.errors.push({ where: 'onAgent', error: short(e), stack: String(e && e.stack || '').slice(0, 400) }); flush('onAgent-error') }))
      })
      rec.ok = true; rec.disposer = typeof d
      if (typeof d === 'function') disposers.push(d)
    } catch (e) { rec.ok = false; rec.error = short(e) }
    R.events.push(rec)
  }
  flush('registered')

  let argShapeSeen = 0
  function onSessionEvent (args) {
    if (argShapeSeen++ === 0) {
      R.eventArgShapes = args.map((a, i) => ({ i, type: kindOf(a), keys: a && typeof a === 'object' ? Object.getOwnPropertyNames(a).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(a) || {})).slice(0, 40) : String(a).slice(0, 60) }))
    }
    const ev = args.find((a) => a && typeof a === 'object' && typeof a.type === 'string' && typeof a.seq === 'number')
    if (ev) {
      R.sessionEventTypeCounts[ev.type] = (R.sessionEventTypeCounts[ev.type] || 0) + 1
      if (!R.sessionEventSamples[ev.type]) R.sessionEventSamples[ev.type] = { seq: ev.seq, dataKeys: ev.data && typeof ev.data === 'object' ? Object.keys(ev.data).slice(0, 12) : kindOf(ev.data) }
    }
  }

  let done = false
  async function onAgent (args) {
    if (done) return
    done = true
    const payload = args[0]
    const agent = val(payload, 'agent') ?? payload
    const D = (o, k) => { const d = desc(o, k); return d.ok ? d.type : 'THROWS' }
    const sess = desc(agent, 'session')
    R.agent = {
      emitArgCount: args.length,
      payloadKeys: Object.keys(payload || {}).slice(0, 15),
      agentKeySample: Object.getOwnPropertyNames(Object.getPrototypeOf(agent) || {}).concat(Object.keys(agent)).slice(0, 60),
      agentIdType: D(agent, 'id'), agentId: (() => { const d = desc(agent, 'id'); return d.ok ? String(d.value).slice(0, 80) : 'THROWS' })(),
      sessionAvailability: sess.ok ? sess.type : 'THROWS:' + sess.error,
    }
    const session = sess.ok ? sess.value : null
    flush('agent-inspected')

    // (a) goals: read-only verb
    let goals = null
    try { goals = ctx.get('goals') } catch (e) { R.goalsProbe.push({ label: 'ctx.get(goals)', ok: false, error: short(e) }) }
    if (goals) {
      for (const [label, fn] of [['goals.get(agent)', () => goals.get(agent)], ['goals.get(agent.id)', () => goals.get(agent.id)], ['goals.get()', () => goals.get()]]) {
        const rec = { label }
        try { let v = fn(); if (v && typeof v.then === 'function') v = await v; rec.ok = true; rec.result = v === undefined ? 'undefined' : v === null ? 'null' : { type: kindOf(v), keys: typeof v === 'object' ? Object.keys(v).slice(0, 12) : String(v).slice(0, 40) } } catch (e) { rec.ok = false; rec.error = short(e) }
        R.goalsProbe.push(rec); if (rec.ok) break
      }
      // (i) revision-conflict shape, via read-only lookups only
      for (const [label, fn] of [
        ['goals.expectCurrent(agent, {id:probe-bogus,revision:99})', () => goals.expectCurrent(agent, { id: 'probe-bogus', revision: 99 })],
        ['goals.view(agent)', () => goals.view && goals.view(agent)],
        ['goals.assertLive(agent, bogus)', () => goals.assertLive && goals.assertLive(agent, { id: 'probe-bogus', revision: 99 })],
      ]) {
        const rec = { label }
        try { let v = fn(); if (v && typeof v.then === 'function') v = await v; rec.ok = true; rec.result = v === undefined ? 'undefined' : v === null ? 'null' : { type: kindOf(v), keys: typeof v === 'object' ? Object.keys(v).slice(0, 12) : String(v).slice(0, 40) } } catch (e) { rec.ok = false; rec.error = short(e); rec.code = (() => { const d = desc(e, 'code'); return d.ok ? d.value : undefined })() }
        R.revisionProbe.push(rec)
      }
    }
    flush('goals-probed')

    // (d) custom session event type
    if (session) {
      for (const m of ['append', 'emit', 'push', 'commit', 'flush', 'get', 'list']) {
        const d = desc(session, m); R.writeApiHunt.push({ on: 'session', method: m, availability: d.ok ? 'fn:' + d.type : 'THROWS:' + d.error })
      }
      const ap = desc(session, 'append')
      if (ap.ok && ap.type === 'function') {
        for (const [label, fn] of [
          ["session.append('converge/ping', {probe:1})", () => session.append('converge/ping', { probe: 1 })],
          ["session.append('converge/ping', {})", () => session.append('converge/ping', {})],
        ]) {
          const rec = { label }
          try { const v = fn(); rec.ok = true; rec.result = v === undefined ? 'undefined' : { type: kindOf(v), keys: typeof v === 'object' ? Object.keys(v).slice(0, 12) : String(v).slice(0, 40), seq: v && v.seq, echoedType: v && v.type } } catch (e) { rec.ok = false; rec.error = short(e) }
          R.appendProbe.push(rec); if (rec.ok) break
        }
        // a non-JSON payload should be rejected: proves validation is payload-side, not type-side
        try { session.append('converge/bad', { when: new Date() }); R.appendProbe.push({ label: 'append with Date payload', ok: true, note: 'ACCEPTED (unexpected)' }) } catch (e) { R.appendProbe.push({ label: 'append with Date payload', ok: false, error: short(e), note: 'expected rejection: exotic object' }) }
      }
    }
    flush('append-probed')

    // (c) agent-scoped registration forms
    for (const type of ['goal/change', 'agent/turn-stopping']) {
      const rec = { type, forms: {} }
      const t = (label, fn) => { try { const d = fn(); rec.forms[label] = { ok: true, disposer: typeof d }; if (typeof d === 'function') disposers.push(d) } catch (e) { rec.forms[label] = { ok: false, error: short(e) } } }
      t('ctx.on', () => ctx.on(type, () => { R.fired['live:' + type] = (R.fired['live:' + type] || 0) + 1 }))
      t('agent.on', () => { const d = desc(agent, 'on'); if (!d.ok || d.type !== 'function') throw new Error('agent.on ' + (d.ok ? 'type=' + d.type : 'THROWS:' + d.error)); return agent.on(type, () => {}) })
      t('session.on', () => { if (!session) throw new Error('no session'); const d = desc(session, 'on'); if (!d.ok || d.type !== 'function') throw new Error('session.on ' + (d.ok ? 'type=' + d.type : 'THROWS:' + d.error)); return session.on(type, () => {}) })
      t('ctx.agentEvents(ctx,agent).on', () => { const h = desc(ctx, 'agentEvents'); if (!h.ok) throw new Error('ctx.agentEvents ' + h.error); return ctx.agentEvents(ctx, agent).on(type, () => {}) })
      R.agentScoped.push(rec)
      flush('agent-scoped:' + type)
    }

    R.lazyServices = sweep()
    R.meta.agentProbeDoneAt = new Date().toISOString()
    flush('done')
  }

  R.apply.returnedWith = 'function'
  flush('apply-return')
  return () => { R.apply.disposedAt = new Date().toISOString(); for (const d of disposers) { try { d() } catch {} } flush('disposed') }
}
