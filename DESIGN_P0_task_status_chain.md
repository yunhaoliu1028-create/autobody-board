# P0 — Task ↔ Status 双向联动 + 阶段自动接棒

> 目标：让 Task 完成和 RO Status 推进真正打通，消除"两套系统互不知道"的断链问题。
>
> **状态：设计已确认，可开始实现。**

---

## 完整工作流（已确认）

| 完成的 task 类型 | 当前 RO status | 建议推进到 | 自动生成 note |
|----------------|--------------|-----------|-------------|
| Check-in（parts_manager） | checked_in | teardown | "Check-in complete. Ready for Teardown." |
| Teardown（body_man） | teardown | body_work 或 waiting_parts* | "Teardown complete. Ready for body work." |
| Body work（body_man） | body_work | body_complete | "Body work complete." |
| Paint prep（painter） | paint_prep | in_paint | "Paint prep complete. Vehicle in paint." |
| Paint job（painter） | in_paint | paint_complete | "Paint complete." |
| Reassembly（body_man） | reassembly | sublet | "Reassembly complete. Ready for Sublet." |
| Sublet（production_manager） | sublet | detail | "Sublet complete." |
| QC/Detail（body_man） | detail | ready | "QC/Detail complete. Vehicle ready for pickup." |

*Teardown 分支见下方特殊逻辑。

---

## 已确认决策

### ✅ Sublet 替换 Calibration（A 方案）

`calibration` 状态从 `roles.js` 移除，改为 `sublet`。

```
旧流程: ... → reassembly → calibration → detail → ready
新流程: ... → reassembly → sublet      → detail → ready
```

`sublet` 涵盖：AC / 4WA / ADAS Calibration / Clear Film，由 Production Manager 负责对接外部供应商。

**`constants/roles.js` 改动：**
```js
// 删除：
{ key: 'calibration', label: 'Calibration', ... }

// 新增：
{ key: 'sublet', label: 'Calibration & Sublet', color: 'bg-emerald-100 text-emerald-800 ...', dot: 'bg-emerald-500' }

// STATUS_GROUPS REASSEM 组：
statuses: ['reassembly', 'sublet', 'detail']   // 原来是 ['reassembly', 'calibration', 'detail']

// ROLE_STATUS_FILTER body_man：
['teardown', 'waiting_parts', 'body_work', 'body_complete', 'reassembly', 'detail']
```

### ✅ Sublet 默认开启，通过 GIB/手动关闭

```js
// RO 文档
needsSublet: true   // 默认 true，大部分车都需要
```

跳过 Sublet 的触发方式：
1. GIB 解析到 "no calibration needed" / "不需要标定" / "no sublet" → 写 `needsSublet: false`
2. Production Manager 在 RO Detail 页手动取消勾选

当 `needsSublet: false` 时，Reassembly 完成后直接推进到 `detail`，跳过 `sublet`。

### ✅ Phase 匹配规则（不是"全部完成"）

**只有 `phase: 'body'` 的 task 完成才触发 body → paint 交接。**

其他 task（customer concern、补做项目、手动 assign 的额外项目）不参与阶段推进判断，body man 做完主线任务就可以交出去，剩下的 task 可以在其他阶段继续完成。

### ✅ 状态推进提示位置：Inline

提示直接出现在 TaskBoard 任务组卡片底部，不弹 Toast，不跳页面。
用户刚点完 Done，眼睛还在卡片上，确认框就出现在正下方。

### ✅ 下游 task 通知方式：NEW badge（不走 Chat）

下游 task 直接出现在被分配人的 TaskBoard 里。
Task 文档加 `assignedAt` 字段，24 小时内的新 task 显示 NEW badge + 日期。

```
┌─────────────────────────────────────────────┐
│  RO#9448  Toyota Camry            3 tasks   │
│                                   🔵 NEW    │
│                            Assigned 5/6     │
│                                              │
│  ○ Paint prep & paint job    [Start] [Note] │
└─────────────────────────────────────────────┘
```

24 小时后 badge 自动消失（`Date.now() - assignedAt.toMillis() > 86_400_000`）。

---

## Feature 1：Task 完成 → 状态推进提示（Inline）

### 触发条件

当某个 RO 的 `phase` 匹配当前阶段的 task 全部变为 completed 时，在该任务组卡片底部展开确认区。

**Phase → 触发检查逻辑：**

| 当前 RO status | 需要检查完成的 phase | 建议推进到 |
|--------------|-------------------|-----------|
| checked_in | `checkin` | teardown |
| teardown | `teardown` | body_work / waiting_parts |
| body_work | `body` | body_complete |
| paint_prep | `paint_prep` | in_paint |
| in_paint | `paint` | paint_complete |
| reassembly | `reassembly` | sublet（或 detail，若 needsSublet=false）|
| sublet | `sublet` | detail |
| detail | `detail` | ready |

### UI（Inline，卡片底部展开）

```
┌─────────────────────────────────────────────┐
│  RO#9448  Toyota Camry            2 tasks   │
│                                              │
│  ✅ Teardown                      Done      │
│  ✅ Process repair                Done      │
│                                              │
│ ╔═══════════════════════════════════════╗   │
│ ║  ✅ Body 阶段完成                     ║   │
│ ║  推进 → Body Complete                 ║   │
│ ║  备注（可选）: ________________       ║   │
│ ║  [ 确认推进 ]       [ 暂不处理 ]      ║   │
│ ╚═══════════════════════════════════════╝   │
└─────────────────────────────────────────────┘
```

- "确认推进" → updateDoc RO status + prepend note string
- "暂不处理" → 关闭提示，不做任何操作，task 保持 completed

### 特殊：Teardown 完成后的分支

```js
if (roDoc.partsStatus === 'all_received') {
  suggestedStatus = 'body_work'
  noteText = 'Teardown complete. Parts already received. Ready for body work.'
} else {
  suggestedStatus = 'waiting_parts'
  noteText = 'Teardown complete. Waiting on parts.'
}
```

---

## Feature 2：阶段交接自动触发下游 Task

RO status 推进时，系统根据 `taskRules`（见 engine 模块）自动建下游 task。

| RO status 变为 | 自动创建 task | 分配给 | phase 标记 |
|--------------|------------|-------|-----------|
| teardown | "Teardown & process repair" | assignedBodyMan | `teardown` |
| body_complete | "Paint prep & paint job" | assignedPainter* | `paint_prep` |
| paint_complete | "Reassembly" | assignedBodyMan | `reassembly` |
| sublet | "Sublet coordination" (AC/4WA/Calibration/Clear Film) | production_manager | `sublet` |
| detail | "QC / Final detail" | assignedBodyMan | `detail` |

*如果 `assignedPainter` 为空，task 分配给 production_manager 并 note 提示"未分配 painter"。

### 下游 task 写法

```js
// engine/taskRules.js 导出的规则驱动
await addDoc(collection(db, 'tasks'), {
  roId, roNumber, vehicleInfo,
  assignedTo:     targetUid,
  assignedAt:     serverTimestamp(),   // NEW badge 计时起点
  title:          taskTitle,
  phase:          taskPhase,
  autoTriggered:  true,
  status:         'pending',
  createdAt:      serverTimestamp(),
})
```

---

## 数据结构变更

### RO 文档新增字段

```js
needsSublet: true     // 默认 true；false = 跳过 sublet 阶段
```

### Task 文档新增字段

```js
phase: 'checkin' | 'teardown' | 'body' | 'paint_prep' | 'paint'
      | 'reassembly' | 'sublet' | 'detail' | null
// null = 手动 task，不参与阶段推进判断

assignedAt: Timestamp   // 分配时间，用于 NEW badge 计算（24h 内显示）

autoTriggered: boolean  // true = 系统自动建的，UI 可显示小标记区分
```

---

## Engine 模块规划（src/engine/taskRules.js）

```js
// 核心导出：给定 RO 新状态，返回应该创建的 tasks
export function getDownstreamTasks(newStatus, roData) {
  // 返回 [{ title, phase, assignedTo, ... }]
}

// 核心导出：给定完成的 task + 当前 RO，返回建议的下一个状态
export function getSuggestedNextStatus(completedTaskPhase, roData) {
  // 返回 { nextStatus, noteText } 或 null（不触发推进）
}
```

所有规则集中在这一个文件里，不散落在 TaskBoard.jsx 中。
换一家店的工作流，只改这一个文件。

---

## 实现计划

### Step 1：更新 constants/roles.js
- 删除 `calibration`，新增 `sublet`
- 更新 STATUS_GROUPS 和 ROLE_STATUS_FILTER

### Step 2：建 src/engine/taskRules.js
- 写 `getDownstreamTasks()`
- 写 `getSuggestedNextStatus()`

### Step 3：建 src/shop-config/
- `cs-sca.js`（当前店配置）
- `index.js`（导出活跃配置）

### Step 4：改 TaskBoard.jsx
- `handleStatusChange` 调用 `getSuggestedNextStatus` → set `pendingPromotion` state
- `DailyTaskGroupCard` 底部渲染 `<StatusPromotionCard>` 组件
- Task 卡片显示 NEW badge（检查 `assignedAt` 时间差）

### Step 5：改 ROBoard.jsx / RODetail.jsx（状态变化时触发下游）
- 任何写 `status` 的地方调用 `getDownstreamTasks()` → 批量建 tasks
