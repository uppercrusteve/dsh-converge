# CORE-ISSUE：请为下游插件提供会话事件类型注册面（consumer 已出现）

**背景（官方口径）**：`@deepseek-ai/dsh-session` 的持久化读侧用 `KNOWN_SESSION_EVENT_TYPES`
裁决会话可否装载（表外类型且无 `ignorable` 标记 → `SessionFormatUnsupportedError`，
"unknown to this harness and not marked ignorable; refusing to interpret the log"）。
catalog 注释自留口子（dsh-session/lib/index.js, known-event-types 区）：
> "Downstream (out-of-repo) plugin events are outside this list by construction;
>  a registration surface for them is **deferred until such a consumer exists**."

**本条即 consumer 报告**：dsh-converge 向会话写 9 个 `converge/*` 私有控制面事件（不进模型
历史、不参与 goal 协议）。不注册则插件写过的会话**装载即拒**（P2/T9b 实测原文错误）。

**现在的做法（灰色面）**：apply 期沿 `argv1→argvN→execPath→import.meta→已知安装根` 探径解析
宿主 `dsh-session` 的**同一模块实例**（探针：Set 已含 build 词表条目 `goal/change`，不符即拒
操作），运行时 `.add()` 9 类型。P3a 真机：headless+web 双 profile `outcome=ok typesTotal=9`，
T9 resume 恢复 1369 事件零误。降级语义：失败只 warn，仅旧会话 resume 受限，绝不炸树。

**请求（任一即可，倾向 1）**：
1. `sessionEventTypes.register(type | types[])`：宿主公开服务（ctx 服务面或 dsh-session
   导出函数），写入与 persistence 读侧**同一活 Set**；重复注册幂等；返回 dispose。
2. 或 `ignorable` 写入通道：允许插件声明其事件为 ignorable（信封已有该标记位且校验放行
   `event.ignorable`），读侧对 ignorable 类型跳过词表裁决。

**破坏面说明（若 core 演进，请连带评估）**：
- 现依赖 `KNOWN_SESSION_EVENT_TYPES` 为**可写活绑定**：若改 `Object.freeze`/只读代理/
  构建期常量化，运行时 `.add()` 抛错——本插件按探针→degraded 安全降级（旧会话 resume 受限
  但无损坏），随后需要迁移到 API 1/2。
- 探针词表词汇改名/移除（现为 `goal/change`）→ 探针 fail-closed 拒注（宁降级不误注），
  请连同注册面一起演进。
- 多拷贝风险已防：非同一 Set 实例（如宿主打包外再解析一份 dsh-session）探针不符即拒。

—— dsh-converge (2026-08 P4)。复现：`tests/register.test.mjs`（13 组，含真机同实例复验）
与 `tests/runs/P3a.t9b.*` / `P3b.*` 真机日志。
