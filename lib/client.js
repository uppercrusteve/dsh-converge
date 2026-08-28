/**
 * dsh-converge 浏览器端 bundle(单文件、零构建、零 npm 依赖,经 __ModuleLoader__ 加载)。
 * 形态与 dsh-cost-meter/lib/client.js 一致(require('react') + createElement)。
 *
 * 三块界面(P3b):
 *  - conversation.chat.turnTail   回合尾卡:该回合的收敛摘要(分数/状态/top3 缺口/nextBestAction);
 *  - conversation.input.dock      输入坞驾驶舱小条:最新收敛态 + 进度条(无研究计划时整条 null);
 *  - settings.section             「收敛驾驶舱」设置分节:阈值/权重只读展示 + notify.enabled 开关。
 * 数据通道:
 *  - 会话投影 'converge'(宿主 pvApply/pvView 折叠)→ 经 conversation.composer.dock 上的探针
 *    组件读 props.useProjection('converge') 灌进本地 store,三块 UI 统一订阅(不依赖各插槽
 *    owner 是否提供 useProjection);
 *  - convergeApi RPC(ctx.get('remote.converge'))→ 设置分节读写;挂载失败只降级设置页。
 * 样式全部走 --dsw-* 主题变量;单条 <style data-plugin-css="dsh-converge">。
 */

window.__ModuleLoader__.load({
  id: 'dsh-converge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const el = React.createElement
    const Fragment = React.Fragment
    const { useState, useEffect, useSyncExternalStore } = React

    const PROJECTION_KEY = 'converge'

    // ── 样式(单标签注入,幂等)────────────────────────────────────────────
    const cssTagId = 'dsh-converge'
    const css = [
      '.cv-tail{display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:var(--dsh-chat-content-width,720px);margin:2px auto 0;box-sizing:border-box;padding:4px 12px;border-radius:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.cv-tail-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.cv-tail-badge.ok{color:var(--dsw-alias-state-success-primary)}',
      '.cv-tail-badge.bad{color:var(--dsw-alias-state-error-primary)}',
      '.cv-tail-meta,.cv-tail-gaps{font-variant-numeric:tabular-nums}',
      '.cv-tail-gaps{color:var(--dsw-alias-state-warn-primary)}',
      '.cv-tail-nba{flex:1 1 200px;min-width:0;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.cv-strip{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;width:100%;max-width:var(--dsh-chat-content-width,720px);margin:0 auto;box-sizing:border-box;padding:2px calc(var(--dsh-composer-side-clearance,0px) + 16px);font-size:11px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.cv-strip-label{font-weight:600;letter-spacing:.02em}',
      '.cv-bar{position:relative;width:120px;height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}',
      '.cv-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--dsw-alias-brand-primary)}',
      '.cv-bar-fill.pass{background:var(--dsw-alias-state-success-primary)}',
      '.cv-num,.cv-meta{font-variant-numeric:tabular-nums}',
      '.cv-meta{color:var(--dsw-alias-label-tertiary)}',
      '.cv-status{padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '.cv-status.ok{color:var(--dsw-alias-state-success-primary)}',
      '.cv-status.warn{color:var(--dsw-alias-state-warn-primary)}',
      '.cv-status.bad{color:var(--dsw-alias-state-error-primary)}',
      '.cv-root{display:flex;flex-direction:column;gap:10px;max-width:640px}',
      '.cv-root h3{font-size:14px;margin:0 0 2px}',
      '.cv-note{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0;line-height:1.6}',
      '.cv-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12px;font-variant-numeric:tabular-nums}',
      '.cv-kv dt{color:var(--dsw-alias-label-tertiary)}',
      '.cv-kv dd{margin:0;color:var(--dsw-alias-label-primary)}',
      '.cv-row{display:flex;align-items:center;gap:8px;font-size:13px}',
      '.cv-btn{font-size:12px;padding:2px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.cv-badge{display:inline-block;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);font-size:11px;font-variant-numeric:tabular-nums}',
      '.cv-err{color:var(--dsw-alias-state-error-primary)}',
    ].join('\n')
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', cssTagId)
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ── 本地投影 store(探针灌入,三块 UI 订阅)────────────────────────────
    function makeViewStore () {
      let snap = { view: null, rev: 0 }
      const listeners = new Set()
      return {
        getSnapshot: () => snap,
        set (view) {
          if (view === snap.view) return
          snap = { view, rev: snap.rev + 1 }
          for (const l of Array.from(listeners)) { try { l() } catch { /* 单个订阅者失败不影响其他 */ } }
        },
        subscribe (l) { listeners.add(l); return () => listeners.delete(l) },
      }
    }
    const viewStore = makeViewStore()

    function useView (props) {
      const store = (props && props.cvStore) || viewStore
      const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      return snap.view
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    function turnOrdinal (t) {
      if (t == null) return null
      if (typeof t === 'number') return Number.isFinite(t) ? t : null
      for (const k of ['turn', 'index', 'turnIndex', 'ordinal']) {
        const v = t[k]
        if (typeof v === 'number' && Number.isFinite(v)) return v
      }
      const sd = t.start && t.start.event && t.start.event.data
      if (Number.isFinite(sd && sd.turn)) return sd.turn
      const ed = t.end && t.end.event && t.end.event.data
      if (Number.isFinite(ed && ed.turn)) return ed.turn
      return null
    }
    const STATUS_LABEL = {
      converged: '已收敛', 'converged-with-gaps': '带缺口收尾', blocked: '收尾被拦',
    }
    function statusClass (s) {
      return s === 'converged' ? 'ok' : s === 'converged-with-gaps' ? 'warn' : s === 'blocked' ? 'bad' : ''
    }
    function fmtPct (n) { return typeof n === 'number' ? Math.round(n * 100) + '%' : String(n) }
    // getSummary().policy.weights 的真形是 [{id,kind,weight,target}]（DEFAULT_CRITERIA）；
    // 对象映射形态也兼容。P4 实点发现裸 Object.entries 会把数组项打成 [object Object]。
    function fmtWeights (w) {
      if (!w) return '—'
      const rows = Array.isArray(w) ? w.map((c) => [(c && (c.id != null ? c.id : c.kind)) || '?', c && c.weight]) : Object.entries(w)
      return rows.map(([k, v]) => k + ' ' + v).join(' / ')
    }
    function digestTitle (d) {
      if (!d) return ''
      const c = d.counts || {}
      const gaps = Array.isArray(d.gaps) ? d.gaps.map((g, i) => `${i + 1}.[${g && g.code}] ${g && g.detail || ''}`).join('\n') : ''
      return ['CONVERGE 收敛分 ' + fmtPct(d.total) + (d.passing ? '(达标)' : '(未达标)') + ' · treeV' + d.treeVersion,
        `证据 ${c.evidence ?? '?'} · 反例覆盖 verdicts ${c.verdicts ?? '?'}/${c.answered ?? '?'}`,
        c.invalidRefs ? `不可解析引用 ${c.invalidRefs} 条` : '引用全部可解析',
        gaps ? '缺口:\n' + gaps : '无阻断缺口',
        d.nextBestAction ? 'nextBestAction: ' + d.nextBestAction : ''].join('\n')
    }

    // ── 探针组件(conversation.composer.dock):唯一确定能拿到 useProjection 的挂载点 ──
    function ProjectionProbe (props) {
      let view
      try { view = typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : undefined } catch { view = undefined }
      useEffect(() => { if (view) viewStore.set(view) }, [view])
      return null
    }

    // ── 回合尾卡(conversation.chat.turnTail)───────────────────────────────
    function TurnTailCard (props) {
      const view = useView(props)
      const ord = turnOrdinal(props.turn)
      const bucket = view && view.byTurn ? view.byTurn[ord === null ? 'pre' : String(ord)] : null
      if (!bucket) return null
      const c = bucket.counts || {}
      return el('div', { className: 'cv-tail', title: digestTitle(bucket) },
        el('span', { className: 'cv-tail-badge ' + (bucket.status === 'converged' ? 'ok' : bucket.status === 'blocked' ? 'bad' : bucket.passing ? 'ok' : '') },
          'CONVERGE ' + fmtPct(bucket.total)),
        el('span', { className: 'cv-tail-meta' }, 'tv' + bucket.treeVersion + ' · e' + (c.evidence ?? '?') + ' · v' + (c.verdicts ?? '?') + '/' + (c.answered ?? '?')),
        bucket.gapCount ? el('span', { className: 'cv-tail-gaps' }, '缺口 ' + bucket.gapCount) : null,
        bucket.nextBestAction ? el('span', { className: 'cv-tail-nba' }, bucket.nextBestAction) : null)
    }

    // ── 输入坞驾驶舱小条(conversation.input.dock):无研究计划时整条 null ──
    function CockpitStrip (props) {
      const view = useView(props)
      if (!view || !view.hasPlan || !view.latest) return null
      const d = view.latest
      const c = d.counts || {}
      const pct = typeof d.total === 'number' ? Math.round(d.total * 100) : 0
      return el('div', { className: 'cv-strip', title: digestTitle(d) || 'dsh-converge 驾驶舱:当前回合收敛状态' },
        el('span', { className: 'cv-strip-label' }, '收敛 CONVERGE'),
        el('span', { className: 'cv-bar' }, el('span', { className: 'cv-bar-fill' + (d.passing ? ' pass' : ''), style: { width: pct + '%' } })),
        el('span', { className: 'cv-num' }, pct + '%'),
        el('span', { className: 'cv-status ' + statusClass(d.status) }, STATUS_LABEL[d.status] || (d.passing ? '达标' : '进行中')),
        el('span', { className: 'cv-meta' },
          'tv' + d.treeVersion + ' · e' + (c.evidence ?? '?') + ' · v' + (c.verdicts ?? '?') + '/' + (c.answered ?? '?')
          + (c.invalidRefs ? ' · 坏引用' + c.invalidRefs : '')
          + (d.gapCount ? ' · 缺口' + d.gapCount : '')))
    }

    // ── 设置分节(settings.section)─────────────────────────────────────────
    function SettingsSection (props) {
      const api = props.api
      const view = useView(props)
      const [st, setSt] = useState({ phase: api ? 'loading' : 'noapi', summary: null, settings: null, error: null, saving: false })
      useEffect(() => {
        if (!api) return
        let dead = false
        const load = async () => {
          try {
            const summary = await api.getSummary()
            const gs = await api.getSettings()
            if (dead) return
            setSt((s) => ({ ...s, phase: 'ready', summary, settings: (gs && gs.settings) || null, error: null }))
          } catch (e) {
            if (!dead) setSt((s) => ({ ...s, phase: 'error', error: String((e && e.message) || e) }))
          }
        }
        void load()
        return () => { dead = true }
      }, [api])
      const notifyOn = !!(st.settings && st.settings['notify.enabled'])
      const toggle = async () => {
        if (!api || st.saving) return
        setSt((s) => ({ ...s, saving: true }))
        try {
          const r = await api.setSetting('notify.enabled', !notifyOn)
          setSt((s) => ({
            ...s, saving: false, phase: 'ready',
            settings: (r && r.settings) || { ...s.settings, 'notify.enabled': !notifyOn },
            error: r && r.ok === false ? String(r.error || '写入失败') : null,
          }))
        } catch (e) {
          setSt((s) => ({ ...s, saving: false, error: String((e && e.message) || e) }))
        }
      }
      const policy = st.summary && st.summary.policy
      const proj = st.summary && st.summary.projection
      return el('div', { className: 'cv-root' },
        el('h3', null, '收敛驾驶舱 Converge'),
        el('p', { className: 'cv-note' },
          '回合尾卡 / 输入坞小条 / 本设置分节的数据来自宿主会话投影 ', el('code', null, 'converge'),
          '(纯函数折叠,与门控共用同一事实源)。投影本地状态:', view ? '已收到(view rev ' + (view.stateVersion ?? 1) + ')' : '等待首个回合事件。'),
        st.phase === 'noapi' ? el('p', { className: 'cv-note' },
          '宿主 RPC 未就绪(未挂载或 typert 注册降级):界面只读投影照常工作,设置暂不可改。') : null,
        st.phase === 'error' ? el('p', { className: 'cv-note cv-err' }, 'RPC 失败: ' + st.error) : null,
        policy ? el('dl', { className: 'cv-kv' },
          el('dt', null, '达标阈值'), el('dd', null, fmtPct(policy.threshold)),
          el('dt', null, '权重'), el('dd', null, fmtWeights(policy.weights)),
          el('dt', null, '单会话提醒上限'), el('dd', null, String(policy.maxInjects ?? '?')),
          el('dt', null, '投影'), el('dd', null, (proj ? proj.key + (proj.registered ? '(已注册)' : '(未注册)') : '?')
            + ' · stateVersion ' + (proj ? proj.stateVersion : '?'))) : null,
        api ? el('div', { className: 'cv-row' },
          el('label', null,
            el('input', { type: 'checkbox', checked: notifyOn, disabled: st.saving, onChange: () => void toggle() }),
            ' 收尾拦截提醒(notify.enabled)'),
          st.saving ? el('span', { className: 'cv-badge' }, '保存中…') : null,
          el('button', {
            className: 'cv-btn',
            disabled: st.saving,
            onClick: () => void (async () => {
              try {
                const gs = await api.getSettings()
                setSt((s) => ({ ...s, phase: 'ready', settings: (gs && gs.settings) || s.settings }))
              } catch (e) { setSt((s) => ({ ...s, error: String((e && e.message) || e) })) }
            })(),
          }, '重新读取')) : null,
        st.error ? el('p', { className: 'cv-note cv-err' }, '最近错误: ' + st.error) : null,
        el('p', { className: 'cv-note' },
          '开关语义:P2 的 turn-stopping 收尾拦截提醒是否注入(notify.enabled;当前为展示与内存/事件持久化,P4 起接入更多行为)。'))
    }

    // ── RPC: 与宿主 pvInvocations 同构的客户端清单 ─────────────────────────
    const passthrough = () => ({ mode: 'strict', typeSymbol: 'dsh-converge#Any', schema: { parse: (v) => v } })
    const CONTRIBUTION = {
      package: 'dsh-converge',
      descriptors: [
        {
          id: 'dsh-converge#converge/getSummary', service: 'convergeApi', namespace: 'converge', method: 'getSummary',
          invocation: { kind: 'direct' }, parameters: [], result: passthrough(),
        },
        {
          id: 'dsh-converge#converge/getSettings', service: 'convergeApi', namespace: 'converge', method: 'getSettings',
          invocation: { kind: 'direct' }, parameters: [], result: passthrough(),
        },
        {
          id: 'dsh-converge#converge/setSetting', service: 'convergeApi', namespace: 'converge', method: 'setSetting',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'key', wire: 'key', source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-converge#SettingKey', schema: { parse: (v) => { if (typeof v !== 'string' || !v) throw new Error('key must be a non-empty string'); return v } } },
            },
            { name: 'value', wire: 'value', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-converge#SettingValue', schema: { parse: (v) => v } } },
          ],
          result: passthrough(),
        },
      ],
    }
    function wrapApi (raw) {
      const unwrap = (r) => {
        if (r && typeof r === 'object' && 'value' in r && 'ok' in r) {
          if (r.ok !== true) throw new Error((r.error && r.error.message) || 'rpc failed')
          return r.value
        }
        return r
      }
      return {
        getSummary: async () => unwrap(await raw.getSummary()),
        getSettings: async () => unwrap(await raw.getSettings()),
        setSetting: async (k, v) => unwrap(await raw.setSetting(k, v)),
      }
    }

    // ── apply ───────────────────────────────────────────────────────────────
    const inject = ['remote']

    async function apply (ctx) {
      let api = null
      try {
        const remote = ctx.remote
        if (remote !== undefined && remote !== null && typeof remote.$mount === 'function') {
          const unmount = await remote.$mount(CONTRIBUTION)
          try { ctx.effect(() => () => { try { if (typeof unmount === 'function') unmount() } catch { /* 忽略 */ } }, 'dsh-converge: remote contribution') } catch { /* 无 effect 面也不致命 */ }
          const raw = ctx.get('remote.converge') ?? ctx.get('remote.convergeApi')
          if (raw) api = wrapApi(raw)
        }
      } catch (e) {
        api = null
        try { console.info('[dsh-converge] remote $mount failed (settings degraded):', (e && e.message) || e) } catch { /* 忽略 */ }
      }
      let slots = null
      try { slots = ctx.get('slots') } catch { slots = null }
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        try { console.info('[dsh-converge] slots service absent (headless host?) - UI registration skipped') } catch { /* 忽略 */ }
        return
      }
      const injected = () => ({ api, cvStore: viewStore })

      // 探针:composer.dock 的 owner 确认提供 useProjection(cost-meter 同槽实证)。
      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'converge-probe', order: 99, inject: () => ({}) },
        ProjectionProbe,
      ))
      // 回合尾卡:宿主 >= 0.1.1-rc.2 把 conversation.chat.turnTail 声明为 chain 槽,注册必须带
      // select(ownerProps) -> matched|null(第一个非 null 的条目当选,matched 并入组件 props;
      // 全 null 则槽位空)。owner 传入 {turn(回合对象), seq, openFile}。按"该回合有投影分桶"当选,
      // 无数据即 decline(null);组件内部再按 store 订阅做二次门控(数据晚到也能补渲染)。
      const selectTurnTail = (ownerProps) => {
        const view = viewStore.getSnapshot().view
        const ord = turnOrdinal(ownerProps && ownerProps.turn)
        const bucket = view && view.byTurn ? view.byTurn[ord === null ? 'pre' : String(ord)] : null
        return bucket || null
      }
      slots.inject('conversation.chat.turnTail', () => slots.register(
        { name: 'conversation.chat.turnTail', id: 'converge-turntail', order: 5, inject: injected, select: selectTurnTail },
        TurnTailCard,
      ))
      // 输入坞驾驶舱小条:无研究计划时组件返回 null(与 cost-meter qstrip 同槽,order 错开)。
      slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'converge-cockpit', order: 20, inject: injected },
        CockpitStrip,
      ))
      // 设置分节。
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'converge', order: 40, label: '收敛驾驶舱', inject: injected },
        SettingsSection,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
