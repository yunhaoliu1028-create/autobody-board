# Autobody Board 全面项目审查报告

- 审查日期：2026-08-18
- 仓库：yunhaoliu1028-create/autobody-board
- 审查性质：只读审计与优化建议
- 数据范围：Firestore 根集合与相关子集合、Storage、Authentication 配置、线上规则与索引、前端源码、GIB / AI 执行链路、构建与依赖、公开竞品资料
- 隐私说明：本文只保留汇总统计和匿名化复现样例，不记录客户姓名、车辆识别信息、电话、照片、聊天正文或任何密钥
- 变更影响：本文是文档，不改变线上数据、应用行为、Firebase 配置或部署

## 1. 执行摘要

Autobody Board 已经不是一个原型，而是一个承载真实生产流程的内部系统。它的最大差异化不是普通 Kanban，也不是通用聊天机器人，而是 GIB：让管理人员用自然语言一次描述多辆车、多类事件，再转换成结构化动作。

当前最重要的策略不是继续增加功能数量，而是先完成一次 Safety & Trust Sprint。现有系统已经积累了有价值的历史数据，但 GIB 写入链路、身份与权限、密钥管理、灾难恢复和 CCC 自动交付判断还没有达到“可以放心扩大自动化”的标准。

核心结论：

1. GIB 的产品方向是正确的，也是最值得继续投资的功能。
2. 当前 GIB 在多 RO 输入中存在跨 RO 串线风险；这类错误会造成错误日期、租车状态、油漆流程或授权状态写入其他 RO。
3. Apply 过程不是原子事务，也没有可靠幂等机制；局部成功、超时重试和重复动作可能造成数据重复或不完整。
4. Firestore 和 Storage 的登录后权限过宽；AI provider key 由浏览器直接读取使用，是当前最高优先级的安全问题之一。
5. 生产数据已经足够支持更强的运营智能，但缺少完整的 GIB 输入、模型版本、编辑差异和执行结果账本，因此目前无法系统评估 AI 准确率。
6. 应把产品定位为 Collision Shop Natural-Language Control Plane：位于 CCC ONE、Mitchell、parts procurement、客户沟通和店内任务系统之上，统一理解、验证、执行和审计操作。

## 2. 审查方法与证据边界

本次结论来自以下只读检查：

- 枚举并汇总 Firestore 根集合、RO、任务、设置、对话和消息文档。
- 检查 Storage 对象数量、大小和规则。
- 检查 Authentication provider 状态与账号形态。
- 对比本地与线上 Firestore / Storage rules、索引和已部署静态资源。
- 审查 GIB parser、AI inference、action editor、apply、undo、Floating Assistant、CCC sync、任务规则和日期处理。
- 运行匿名化 parser / inference 复现输入。
- 检查构建体积、npm advisories 和现有自动化测试覆盖。
- 对照行业公开产品页面进行横向分析。

证据分级：

- 已验证：由当前数据、线上配置、源码或可复现实验直接支持。
- 高概率风险：代码路径明确存在，但尚未在真实用户账号中完成端到端操作。
- 产品建议：基于已验证事实提出的设计和路线判断。

限制：

- 本次没有使用真实客户数据做破坏性测试。
- 没有代表不同角色登录生产 UI 进行写入测试。
- 竞品结论基于公开资料，不代表已完成商业采购或付费试用。
- 依赖漏洞数量不等于浏览器端可直接利用，需要逐项确认可达性。

## 3. 数据与系统现状

### 3.1 Firestore 汇总

审查快照共计 764 个文档：

- RO：191
  - Delivered：175
  - Active：15
  - Total Loss：1
- Tasks：524
- Users：11
- Conversations：7
- Messages：28
- Settings：3

其他数据质量指标：

- 92.7% 的 RO 有 notes。
- 97.9% 的 RO 有 changeLog，共 4,123 条 changeLog 记录。
- 154 个 RO 含 GIB 结构化历史，共 1,007 个 GIB actions。
- 未发现重复 RO number。
- 未发现非法主 status。
- 未发现明显 orphan RO 或 orphan user reference。

这说明系统已经形成可观的运营资产。但现有 GIB 历史主要保存结构化结果，没有完整保存：

- 原始输入文本
- 分段后的 per-RO 输入
- parser / prompt / model 版本
- 用户在确认前的编辑差异
- 被拒绝或被阻止的动作
- 每个动作的最终写入结果和 operationId

因此，现阶段能统计“做过多少动作”，却不能可靠回答“模型最初理解对了多少、用户纠正了什么、错误发生在哪一层”。

### 3.2 Storage

- 对象数量：90
- 总体积：约 22.6 MB
- 未启用 object versioning

数据量目前不大，但缺少版本保护意味着误删或覆盖后的恢复能力有限。

### 3.3 恢复能力

审查时确认：

- Firestore Point-in-Time Recovery：关闭
- Firestore backup schedules：0
- Firestore backups：0
- Firestore delete protection：关闭
- 默认恢复窗口：约 1 小时
- Storage versioning：关闭

这是生产系统的明显运营风险。任何批量脚本、错误 AI 写入或误删除，都可能超过现有恢复能力。

建议在下一轮重构前先建立恢复点：

1. 启用 Firestore PITR。
2. 配置每日 backup schedule 和保留策略。
3. 开启 database delete protection。
4. 为关键 Storage bucket 开启 versioning 或定期导出。
5. 演练一次恢复到独立项目，不只验证“备份任务成功”。

## 4. 风险优先级总览

| 优先级 | 问题 | 可能影响 |
|---|---|---|
| P0 | 多 RO 输入跨 RO 串线 | 错误日期、租车状态、流程或授权写入其他 RO |
| P0 | AI provider key 暴露给浏览器和所有登录用户 | 密钥泄露、滥用、账单和数据风险 |
| P0 | Apply 非原子且无幂等 | 局部写入、重复 notes/tasks/receipts/returns |
| P0 | 编辑 RO / assignee 显示值后仍保留旧 ID | 用户以为已纠正，实际仍写入原对象 |
| P0 | 单次 CCC 缺失扫描可自动标记 Delivered | 活跃 RO 被误结案 |
| P0 | 登录后 Firestore / Storage 权限过宽 | 越权读取、修改或上传 |
| P1 | Undo 不完整且仅内存保存 | 无法可靠恢复，刷新后丢失 |
| P1 | no replacement parts 直接清空 partsOrders | 历史证据被破坏 |
| P1 | Floating Assistant 与 GIB 使用不同执行器 | 同一句话在两个入口产生不同结果 |
| P1 | 备份、PITR、delete protection、Storage versioning 均关闭 | 错误写入或删除难以恢复 |
| P1 | Delivered RO 留有大量未完成任务 | 任务视图、运营统计和提醒失真 |
| P1 | Revenue delivered date 大量回退到 updatedAt | 月度收入归属可能漂移 |
| P2 | 单 bundle 较大、路由未充分拆分 | 移动端首屏、PWA 更新体验偏重 |
| P2 | 测试主要集中在 parts parser | 关键状态机、权限、时区和执行链路缺少回归保护 |

## 5. GIB / AI 逻辑专项审查

### 5.1 多 RO 作用域串线

匿名化复现输入：

> RO1111 no rental, target 8/20; RO2222 has rental, target 8/25

当前 deterministic inference 会在处理每个 action 时重复读取整段 input，而不是对应 RO 的局部 clause。结果是 RO2222 可能继承 RO1111 的 no rental 和 8/20。

相关位置：

- src/utils/aiActionInference.js：输入标准化与整段匹配
- src/components/AIInputBox.jsx：按 action / RO 归一化时仍引用全局 input

相同问题还影响：

- ready for paint
- authorized / authorization release
- paint prep / paint 自动任务
- parts vendor、quantity 和 ETA
- rental status
- target date

高概率复现：

> RO1111 ready for paint; RO2222 customer called

第二个 RO 也可能被添加 Paint Prep / Paint 任务或推进状态，因为 ready-for-paint 判断使用了整段输入。

修复原则：

1. 先把原始输入分割为明确的 per-RO segments。
2. 每个推断函数只接收一个 RO segment，不允许接收整段 input。
3. 无法唯一归属的句子进入 Unscoped observations，不自动写入。
4. 多 RO input 中禁止把“最近出现的日期 / vendor / 状态”跨 segment 传播。
5. 为 comma、semicolon、slash、double slash、and、Chinese punctuation 和语音转写断句分别建测试。

### 5.2 Parts parser 的作用域与污染

匿名化复现：

> RO1111 ordered 1 Keystone, RO2222 ordered 2 Amazon ETA 8/25

当前 parser 在部分逗号、斜杠和短句组合中可能把两条 order 都归到第一个 RO，并把后一个 ETA 传播给前一个 vendor。

已确认的相关风险：

- received 信息被误恢复成新 order
- temporal words 被拼入 vendor name
- ETA 跨 clause 泄漏
- 同一 vendor 的 completed historical order 与新 order 合并
- 弱 action 覆盖信息更完整的 action

2026-08-18 已对已报告的 Sepaplus / Keystone case 做过 parser hardening，并增加 12 个回归测试；但多 RO segmentation 应继续上移到所有 inference 之前，不能只靠 parts parser 局部防御。

### 5.3 日期校验不足

现有路径可接受不存在的日期，例如 2/30。还存在以下风险：

- 只有月日，没有年份时推断错误年份。
- 前端用 UTC 转换日期，在 Pacific 下午或晚间产生前后一天偏差。
- vendor ETA、RO target date、drop-off date 的合法范围没有统一规则。
- translated text 和 original text 可能提供不同日期，缺少冲突提示。

建议建立统一 DateValue：

- rawText
- normalizedDate
- timezone
- inferredYear
- sourceSegment
- confidence
- validationErrors

硬校验：

- 必须是合法日历日期。
- target date 不应早于合理业务边界。
- ETA 和 delivery target 必须分开。
- 年份推断必须在 UI 明示。
- original 与 translation 冲突时阻止 Apply。

### 5.4 Action 编辑器存在 stale identifier

已确认：

- 编辑 roNumber 只改变显示字段，没有清除旧 roId。
- Apply 时优先使用 roId，因此用户看见的新 RO number 可能没有实际生效。
- 编辑 assigneeName 没有清除 assigneeUid。
- Apply 时优先使用 assigneeUid，因此任务仍可能派给旧员工。

这是危险的“显示正确、执行错误”问题。

修复：

- RO selector 必须存一个对象：{ id, roNumber }。
- Employee selector 必须存一个对象：{ uid, name, role }。
- 任何显示文本变化都必须重新解析唯一 ID。
- 不允许用户自由编辑 name 后保留旧 uid。
- Apply 前验证 ID 与展示值仍然一致。
- 保存 execution plan 后，执行器只读取 immutable object identity。

### 5.5 Apply 非原子、无幂等、超时不取消

当前 Apply 会启动多个 addDoc / updateDoc Promise。验证和写入不是一个不可分割步骤：

- 前面的写入已经开始后，后续验证仍可能失败。
- Promise.all 中任一失败，不会取消其他已发送写入。
- 20 秒 timeout 只结束等待，不会取消 Firestore 请求。
- 用户重试可能重复 notes、returns、receipt increments 和 tasks。
- 同一动作在部分成功后没有 durable status 供下次重放判断。

建议引入两阶段执行：

Phase A — Build Plan

- 完成 segmentation、identity、date、role、state、duplicate 和 permission validation。
- 生成 immutable ExecutionPlan。
- 所有 blocked actions 必须在任何写入前被处理。

Phase B — Commit Plan

- 每次 Apply 生成 operationId。
- 每个 action 生成 deterministic actionId。
- 同一 RO 的字段更新和 ledger entry 使用 transaction / batch。
- create task / receipt increment 等写入检查 actionId 是否已经执行。
- 失败时记录 succeeded / failed / skipped，而不是只返回 Promise error。
- 重试从 ledger 恢复，绝不盲目重复。

### 5.6 Undo 不可靠

现有 Undo 主要恢复部分 RO 字段或删除新 task，但不能完整恢复：

- complete_phase 对既有 task 的修改
- parts received increment
- returns
- notes 字符串拼接
- 并发用户在 Apply 后做出的修改

Undo 信息保存在内存中，刷新后丢失；直接写回旧 snapshot 还可能覆盖其他人的新修改。

建议改为 durable compensating actions：

- 每个成功 action 保存 before / after、document version 和 inverse operation。
- Undo 是一条新的审计操作，而不是静默回滚。
- 并发版本不同则阻止自动 Undo，进入人工 review。
- 设置可撤销窗口，例如 15 分钟。
- 高风险动作要求二次确认。

### 5.7 no replacement parts 破坏历史

当前 noReplacement 路径可能直接将 partsOrders 设置为空数组。这会删除历史 vendor / quantity / ETA / receipt 证据。

建议：

- 永不清空历史数组。
- 写入 partsRequirement: none 或 noReplacementParts: true。
- 旧 order 标记 voided / superseded，并记录原因和操作人。
- 如果已有 received / return 活动，必须阻止自动 no-replacement。
- UI 明确显示“无需替换件”和“历史订单仍保留”。

### 5.8 GIB 与 Floating Assistant 双执行器

Floating Assistant 和 GIB 拥有两套不同的 context、normalization 和 executor：

- Floating context 主要包含 ROs / users，缺少完整 tasks、per-vendor partsOrders 和 assignment state。
- prompt 却要求回答 outstanding tasks / parts，模型拿不到足够事实。
- 角色数据隔离主要依赖 prompt，而不是服务器端 query / authorization。
- Floating 缺少 GIB 的部分 vendor/date/reject/dedupe hardening。
- Floating 逐条写入，没有同等 review / edit / undo 流程。
- inline mode 的数据加载依赖 open state，存在永久 Loading 的路径。

建议只保留一个 Action Planning API 和一个 Executor。GIB、Floating、移动端和未来语音入口只是不同 UI，不应各自实现业务规则。

### 5.9 翻译不应作为事实源

当前 translation 会进入解析链路。翻译适合帮助用户阅读，但不能替代 original text：

- 翻译可能改变否定、数量、vendor 拼写和日期关系。
- 同一事实如果只存在于 translation，不应自动 Apply。
- original 与 translation 冲突时必须显示冲突。

建议 UI 同时显示：

- Original evidence
- Translation for display
- Structured fact
- Confidence / validation
- Current value → proposed value

## 6. 安全、身份与权限

### 6.1 AI 密钥暴露在客户端

已确认设置文档包含 Anthropic / OpenAI key，useAI 从 Firestore 下载 key 后由浏览器直接放入 provider request header。现有 rules 允许所有登录员工读取 settings。

影响：

- 任一登录账号或被窃取 session 可提取 provider key。
- 无法可靠限制单用户配额。
- provider 可看到从浏览器直接发送的全部 context。
- 密钥轮换和 provider 审计困难。

P0 修复：

1. 立即轮换已使用的 provider keys。
2. 将 AI 调用迁移至 Cloud Functions / Cloud Run proxy。
3. 使用 Secret Manager，不将 key 写入 Firestore。
4. 服务端按 uid、role、shopId 执行 authorization 和 context filtering。
5. 添加 App Check、rate limit、request size limit、daily budget 和 audit log。
6. 返回结构化 schema，不允许浏览器绕过 validator 直接执行。

### 6.2 Firestore rules 过宽

当前规则对已登录用户提供过大的读取和写入范围，包括：

- 读取全部 ROs
- 读取全部 users
- 读取 settings
- 更新任意 RO

这与 UI 中“worker 只看 assigned ROs”的描述不一致。UI filter 和 prompt 不是安全边界。

建议：

- 每个文档带 shopId。
- 通过 custom claims / membership document 验证 active shop membership。
- manager / estimator / parts_manager / worker 使用不同规则。
- worker 只读其允许的 RO / task；敏感字段单独拆集合或服务端代理。
- 设置文档按类别分离；任何 secret 都不进入 Firestore client-readable path。
- 增加 rules emulator tests，覆盖 allow 和 deny 两类 case。

### 6.3 Storage rules 过宽

当前任一登录用户可以读取和写入广泛的 RO / chat 路径，缺少：

- shop / RO membership validation
- role validation
- 文件大小限制
- MIME allowlist
- path ownership
- quarantine / malware workflow

建议：

- 路径中加入 shopId 和 entityId。
- 用 Firestore membership / task assignment 校验访问。
- 图片限制可接受 MIME、单文件大小和数量。
- 禁止可执行文件和任意 contentType。
- 上传先写临时区，服务端验证后再发布。
- 图片下载 URL 和缓存策略应在 logout 时失效或清理。

### 6.4 Deactivate 不是真正禁用

Settings 的 deactivate 只修改 Firestore active，但 AuthContext、ProtectedRoute 和 rules 没有一致强制 active。账号可能仍能登录并访问。

建议：

- 服务端 membership active=false 立即拒绝 token 对应业务访问。
- 高风险时同步 disable Firebase Auth user。
- 每次 privileged request 检查 active membership。
- UI logout 只是体验层，不是安全措施。

### 6.5 Phone authentication 风险

审查时：

- 9 个 phone account
- 2 个 password account
- Phone sign-in provider 当前关闭

关闭 provider 会导致新设备或清除 session 后无法重新使用原登录方式。若直接重新开启，而当前首登逻辑仍自动创建 active body_man，则陌生手机号可能获得店内访问。

建议使用 invite-only：

- manager 先创建 invitation / membership。
- 首次 phone login 只有匹配 invitation 才能激活。
- 未邀请号码进入 pending，不自动建 active user。
- invitation 有有效期、角色和 shopId。
- 对首登、角色升级和停用写审计记录。

## 7. CCC 同步与自动状态

当前 CCC sync 存在一个高风险自动化：单次成功扫描中未找到某 RO 时，可能把该 RO 标记 Delivered。

网页、登录、过滤器、分页、网络、CCC UI 变化都可能造成“本次没看到”，但这不等于“车辆已交付”。

建议状态机：

1. missing_candidate：第一次缺失，只记录候选。
2. missing_confirmed：连续 2–3 次完整成功扫描仍缺失。
3. manager_review：显示候选列表和证据。
4. delivered：管理人员确认，或来自更可靠的 explicit delivered signal。

必须加入：

- 扫描总 RO 数异常下降 fuse。
- 页面 / filter / pagination 完整性检查。
- 同步开始与结束 checkpoint。
- 每个 delivered 决策的 source、scanId 和 evidence。
- 批量状态变化预览。
- 可恢复的 previous state。
- CCC UI selector 变化时 fail closed。

## 8. 数据质量与运营逻辑

### 8.1 Delivered RO 的未完成任务

发现：

- 378 个 incomplete tasks 仍关联 Delivered ROs。
- 23 组 active task 可能重复。
- 28 个 RO-linked tasks 没有 assignee。

影响：

- 员工 My Work 被历史任务污染。
- outstanding task 数量不可信。
- AI 可能基于脏任务给出错误优先级。
- reminder / dashboard 失真。

建议建立 archive / close policy：

- RO Delivered 时，不应简单删除 task。
- pending task 自动标记 cancelled_by_delivery。
- in_progress task 要求 manager resolution。
- 保留完成历史、取消原因和时间。
- active query 默认排除 archived / cancelled。
- 一次性数据清理先 dry-run、导出候选，再人工确认。

### 8.2 Delivered 日期不稳定

175 个 Delivered RO 中，119 个 revenue calculation 会回退使用 updatedAt，而不是稳定的 deliveredAt。RO 在交付后被补 note 或调整字段，会改变 updatedAt，从而把 revenue 归到错误月份。

建议：

- 第一次进入 Delivered 时写 immutable deliveredAt。
- 纠错使用 deliveredAtCorrection + reason，不覆盖历史而无记录。
- Revenue 只使用 deliveredAt / approved correction。
- 不再使用 updatedAt 作为长期财务事实。
- 对历史数据做一次有证据的 backfill，无法确定的标记 unknown。

### 8.3 状态字段漂移

Delivered RO 的 carStatus 分布：

- car_in_shop：122
- pending_dropoff：52
- missing：1

status=delivered 与 carStatus 仍表示在店/待进店，说明多个状态字段没有统一生命周期。

建议定义单一来源：

- workflowStatus：维修流程
- physicalVehicleState：车辆是否在店
- commercialState：active / delivered / total_loss / archived

由统一 transition command 同时维护，而不是多个组件自由写字段。

### 8.4 Active RO 完整性

15 个 active RO 中有 6 个缺 due date。是否必须有 due 取决于流程阶段，但至少应有：

- unknown reason
- expected next review date
- owner
- last customer update

建议做 Active RO readiness score，不强行填假日期。

### 8.5 Parts 数据候选

发现的人工复核候选包括：

- 1 条 missing vendor
- 3 条 missing / zero quantity
- 1 条 received > ordered
- 4 条 incomplete 且 missing ETA
- 6 组 duplicate vendor rows
- 3 个 all_received 但仍存在 incomplete line

这些不应直接自动修复。建议生成 Parts Reconciliation queue：

- canonical vendor
- ordered / received / returned
- active / completed / voided
- ETA source
- discrepancy reason
- suggested fix
- manager approval

### 8.6 changeLog 噪声

4,123 条 changeLog 中约 1,928 条为 board_order，接近 47%。频繁拖拽排序会淹没有业务意义的事件。

建议：

- board order 独立为 UI preference / ordering collection。
- changeLog 保留状态、字段、任务、parts、customer 和 AI 执行事件。
- 高频拖拽做 debounce / coalesce。
- 审计页默认隐藏 presentation-only events。

## 9. UI / UX 优化

### 9.1 GIB 确认界面

当前界面同时出现：

- 顶部 action summary
- 下方 action card
- translation
- warning badge
- edit / remove icon

重复信息较多，颜色更多表达 action type，而不是风险等级。

建议改为 per-RO lanes：

RO #9725  
Current state → Proposed state

每个 lane 内：

- Verified facts
- AI suggestions
- Warnings / blocked actions
- Evidence excerpt
- Current value → New value
- Edit / Remove

颜色语义统一：

- Green：validated, safe to apply
- Amber：needs confirmation
- Red：blocked
- Gray / blue：informational

### 9.2 Apply footer

使用 sticky footer，持续显示：

- 5 valid
- 1 warning
- 1 blocked
- Apply 5 Valid Actions
- Review Blocked

只要存在 blocked action，不允许含混地 Apply All。

### 9.3 可点击区域和移动端

编辑 / 删除图标应至少 44×44 CSS pixels，并有：

- 明确 tooltip / aria-label
- keyboard focus
- destructive confirmation
- undo availability

### 9.4 Morning Huddle

这是最有机会带来惊喜、也最贴合 body shop 日常的新增界面：

- 今日预计交付
- due / overdue
- 等件和 ETA 风险
- 无 assignee 或 stale task
- supplement / authorization blocker
- customer update overdue
- paint / body / reassembly capacity
- 昨日 GIB 执行异常

用户可以直接说：

> Give me the morning huddle, then move the confirmed ready cars forward.

AI 先给证据化汇总，再生成需确认的动作计划。

### 9.5 PWA 与性能

线上主 JS bundle 约 1,309,824 bytes。建议：

- route-level lazy loading
- 将 manager-only、reports、settings、AI review 拆 chunk
- 重型 libraries 按需加载
- 对长列表 virtualize
- 对 notes / photos 使用分页和缩略图
- 在真实低端 Android / iPhone 上量测 LCP、INP 和 memory

其他体验风险：

- 30 天 photo cache 可能在 logout 后保留。
- viewport 禁用 pinch zoom，影响可访问性。
- 强制 portrait 限制平板 / 横屏场景。
- 缺少明确 CSP、Permissions-Policy 和 Referrer-Policy。
- 某些 where + orderBy task query 需要复核 composite indexes。

## 10. 架构建议

建议把所有自然语言入口统一为以下管线：

Input / Voice  
→ Per-RO Segmentation  
→ Deterministic Facts + AI Suggestions  
→ Typed Action Schema  
→ Identity / Date / State / Permission / Conflict Validation  
→ Immutable Execution Plan  
→ Per-RO Human Review  
→ Transactional Executor with operationId  
→ Event Ledger + Durable Undo

### 10.1 Typed Action Schema

每个 action 至少包含：

- actionId
- operationId
- shopId
- roId
- roNumberSnapshot
- type
- payload
- sourceSegment
- evidence
- parserVersion
- model / promptVersion
- confidence
- validationStatus
- validationErrors
- currentValue
- proposedValue
- createdBy
- createdAt
- executedAt
- executionStatus

### 10.2 Facts 与 Suggestions 分离

Deterministic facts：

- 明确 RO number
- 明确 vendor / quantity
- 明确日期
- 明确 no rental
- 明确 phase phrase

AI suggestions：

- 哪个状态最合理
- 是否应该创建 downstream task
- 哪个 blocker 更紧急
- customer update draft
- next-best action

AI 不应默默把 suggestion 伪装成输入事实。

### 10.3 GIB Flight Recorder

为每次提交保存：

- raw input
- original language
- translated display text
- segmentation
- deterministic parse
- model output
- normalized actions
- user edits / deletions
- blocked reasons
- execution result
- latency / token / cost
- app / parser / prompt version

敏感字段需分级保留、访问控制和 retention policy。

### 10.4 Replay Lab

从已匿名化的真实错误模式构建 golden tests：

- 多 RO
- 多 vendor
- 中英混合
- 语音断句
- 否定
- received vs ordered
- ETA vs delivery target
- invalid date
- typo vendor
- authorization
- no replacement
- same RO repeated
- edit identity
- retry after partial failure
- Pacific timezone boundary

每次 parser / prompt / model 升级先离线 replay，再部署 canary。

## 11. 测试、依赖与可维护性

现有明确自动化覆盖主要是 12 个 parts parser regression cases。对系统风险来说远远不够。

建议测试金字塔：

Unit

- segmentation
- date parser
- vendor canonicalization
- action dedupe
- status transitions
- role eligibility
- idempotency key

Integration with Firebase Emulator

- Firestore allow / deny rules
- transaction conflicts
- duplicate retry
- durable undo
- inactive user
- task completion and downstream creation

End-to-end

- manager GIB review / edit / apply
- worker visibility
- parts update
- CCC sync candidate delivery
- PWA refresh and offline recovery
- phone invitation onboarding

审查时 npm audit 报告 16 个 advisories：

- Critical：1
- High：3
- Moderate：12

这些包括 transitive dependencies，不能仅凭数量判断实际暴露，但应：

1. 导出 dependency path。
2. 判断是否进入 production bundle / build tooling。
3. 优先处理 reachable critical / high。
4. 升级后运行 GIB replay、build、PWA 和 Firebase tests。
5. 配置 Dependabot / Renovate，避免再次积累。

## 12. 市场横向分析

| 产品 | 公开定位 | 强项 | 对 Autobody Board 的启示 |
|---|---|---|---|
| CCC ONE Workflow | Collision repair workflow / shop management | 行业渗透、估损与维修生态 | 不正面复制；做其上层操作与异常控制 |
| Mitchell Cloud Repair | Cloud repair management | 估损、维修、协作生态 | 以更轻、更自然的店内执行层差异化 |
| Qapter | AI-assisted claims / estimating technology | 视觉与估损自动化 | 不把核心资源投入通用图像估损竞争 |
| Tractable | Computer vision for insurance / repair | 图片评估、保险工作流 | 作为未来集成或证据源，而非当前主战场 |
| PartsTrader Orderly | AI parts procurement | end-to-end parts procurement | GIB 应消费 order / ETA / receipt 信号并做 reconciliation |
| Partly Interpreter | Parts data interpretation | 部件数据标准化 | vendor / part normalization 可借鉴 schema 思路 |
| BodyShop Booster | Customer communication and digital intake | customer journey / updates | 可补强 customer update drafts，但保留人工发送 |
| CR Auto Scheduler Production | Collision scheduling / capacity | 生产排程 | 可在干净任务数据之上增加 capacity intelligence |

官方资料：

- [CCC ONE Workflow](https://www.cccis.com/collision-repairers/shop-management/vehicle-workflow)
- [Mitchell Cloud Repair](https://www.mitchell.com/solutions/collision-repairers/repair-management/cloud-repair)
- [Qapter](https://www.qapter.com/technology/)
- [Tractable](https://tractable.ai/)
- [PartsTrader Orderly](https://www.partstrader.com/news_updates/partstrader-launches-orderly-ai-powered-end-to-end-procurement-for-collision-repair-industry/)
- [Partly Interpreter](https://www.partly.com/partly-interpreter)
- [BodyShop Booster](https://bodyshopbooster.com/features)
- [CR Auto Scheduler Production](https://www.collisionresourcesinc.com/cr-auto-scheduler-production)

建议定位：

> The natural-language control plane for collision shop operations.

不是另一个 chat window，也不是另一个 generic board，而是：

- 读懂店内 shorthand
- 把多个系统的事实归到正确 RO
- 在写入前验证
- 生成可审核的 operation plan
- 安全执行
- 记录每一步证据
- 主动暴露 blocker 和 next-best action

## 13. 优先路线图

### 0–7 天：止血与恢复

- 为当前代码和数据建立可恢复 checkpoint。
- 启用 Firestore PITR、backup schedule、delete protection。
- 开启 Storage versioning 或等效备份。
- 轮换 AI keys，停止客户端读取 provider secret。
- 设计后端 AI proxy 最小版本。
- 修复 per-RO segmentation。
- 修复 stale roId / assigneeUid。
- 添加严格日期校验和 Pacific timezone tests。
- 所有 validation 在任何写入前完成。
- no replacement 不再删除 parts history。
- CCC 单次 missing 不再自动 Delivered。
- 修复必要 composite indexes。

### 2–4 周：统一执行与清理

- 建立 shared action schema、validator 和 executor。
- 引入 operationId / actionId、transaction 和 idempotency。
- 建立 durable event ledger 和 compensating undo。
- 合并 GIB 与 Floating Assistant 执行链路。
- 建立 delivered task archive / resolution policy。
- 引入 immutable deliveredAt。
- 生成 parts reconciliation queue。
- 增加 rules、GIB、CCC、timezone emulator tests。

### 1–3 个月：产品体验升级

- 上线 per-RO GIB review lanes。
- 上线 evidence-first Current → Proposed cards。
- 增加 Morning Huddle。
- 区分 Active / Archive 数据视图。
- route split 与移动端性能优化。
- 服务端 role-filtered AI context。
- GIB Flight Recorder 和 Replay Lab。
- 建立可量化的 GIB accuracy dashboard。

### 3–12 个月：差异化能力

- Parts document / screenshot OCR 和 reconciliation。
- Vendor ETA reliability scoring。
- Technician / paint / parts capacity scheduling。
- Customer update drafts，人工批准后发送。
- 对接 CCC / Mitchell / parts / customer communication 标准接口。
- 基于 blocker、cycle time 和 capacity 的 next-best action。

## 14. 成功指标

安全与可靠性：

- 0 个跨 RO action。
- 0 个客户端可读取 provider secret。
- 100% Apply operation 有 operationId 和 durable outcome。
- 重试不会增加重复 action。
- 100% 高风险动作可审计。
- 恢复演练达到明确 RPO / RTO。

GIB 产品指标：

- Per-action precision。
- Per-RO segmentation accuracy。
- User edit / delete rate。
- Blocked action false-positive rate。
- Partial failure rate。
- Median review time。
- 语音输入到完成更新的总时间。
- 按 parser / prompt / model version 的 regression trend。

运营指标：

- 未分配 active tasks。
- Delivered ROs with incomplete tasks。
- Parts ETA completeness。
- Customer update freshness。
- Due-date completeness。
- Cycle time by phase。
- Morning Huddle 后 blocker resolution time。

## 15. 建议的第一批工程任务

1. GIB per-RO segmenter 与 golden regression suite。
2. Action identity object 修复，消除 stale roId / uid。
3. BuildPlan / CommitPlan 两阶段重构。
4. operationId、actionId 和 execution ledger。
5. Backend AI proxy、Secret Manager、key rotation。
6. Firestore / Storage least-privilege rules 与 emulator deny tests。
7. Invite-only phone onboarding 与真正的 deactivate enforcement。
8. CCC missing candidate 状态机。
9. Stable deliveredAt 与 delivered task archive。
10. Morning Huddle read-only MVP。

## 16. 结论

Autobody Board 已经证明自然语言可以减少 collision shop 的更新摩擦。下一阶段最有价值的工作，不是让 AI“说更多”，而是让它：

- 只作用于正确的 RO
- 只使用可追溯的事实
- 在写入前暴露冲突
- 在失败和重试时保持一致
- 让每次变化都能解释、审计和恢复

如果先完成安全、分段、验证、幂等和账本，再推进 Morning Huddle、parts reconciliation 和 capacity intelligence，这个项目会从“很好用的内部工具”升级为一个可信的 collision operations control plane。
