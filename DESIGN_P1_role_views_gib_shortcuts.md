# P1 — 角色差异化 TaskBoard + GIB 快捷操作栏

> 目标：让每个角色打开 Tasks 页面时，看到的都是"为他量身定做"的界面和操作，GIB 无缝嵌入，不用打字也能完成 80% 的日常更新。

---

## 核心思路

现在所有人看到的 TaskBoard 是同一套 UI，只是数据不同。  
这里的改动是：**不同 role 有不同的 UI 布局、信息密度和 GIB 快捷操作**。

---

## Feature 1：Role-Aware GIB 快捷操作栏

在 TaskBoard 顶部（Manager View 下方）加一排**上下文感知快捷按钮**，  
每个按钮 = 预填好的 GIB 指令，点击 → 弹出简单确认/补充 → 一键执行。

### Body Man 快捷栏

```
[ 📦 零件到了 ]  [ ✅ Body 完成 ]  [ ⏸ 等零件 ]  [ 📋 加备注 ]
```

| 按钮 | 预填 GIB 动作 | 需要用户补充 |
|------|------------|------------|
| 📦 零件到了 | `update_parts_status: all_received` + `add_note: Parts received.` | 选择哪个 RO（如果 >1 个） |
| ✅ Body 完成 | `update_status: body_complete` + `add_note: Body work complete.` | 选择哪个 RO |
| ⏸ 等零件 | `update_status: waiting_parts` + `add_note: Waiting on parts.` | 选择哪个 RO + 可选备注 |
| 📋 加备注 | 弹出备注框 + RO 选择 | RO + 备注内容 |

### Painter 快捷栏

```
[ 🎨 开始 Paint Prep ]  [ 🖌 进油漆房 ]  [ ✅ 油漆完成 ]
```

| 按钮 | 预填 GIB 动作 |
|------|------------|
| 🎨 开始 Paint Prep | `update_status: paint_prep` |
| 🖌 进油漆房 | `update_status: in_paint` |
| ✅ 油漆完成 | `update_status: paint_complete` + note |

### Parts Manager 快捷栏

```
[ 📬 零件已下单 ]  [ 📦 部分到货 ]  [ ✅ 全部到货 ]  [ ⚠️ 零件延迟 ]
```

| 按钮 | 预填 GIB 动作 |
|------|------------|
| 📬 零件已下单 | `update_parts_status: ordered` + note（含 vendor）|
| 📦 部分到货 | `update_parts_status: partially_received` |
| ✅ 全部到货 | `update_parts_status: all_received` + note |
| ⚠️ 零件延迟 | `add_note: Parts delayed. New ETA: ____` + 提示 manager |

### Estimator 快捷栏

```
[ ✅ 已授权 ]  [ 📝 提交 Supplement ]  [ 📞 已联系客户 ]  [ ⚠️ TL 风险 ]
```

### Manager / Production Manager 快捷栏

```
[ 📊 今日简报 ]  [ 📤 发客户短信 ]  [ 👷 分配人员 ]
```

- **今日简报** → 一键触发 GIB 生成 `askShopAssistant` 今日概览
- **发客户短信** → 选 RO → GIB 生成中文短信草稿

---

### 快捷按钮交互流程

```
用户点 [📦 零件到了]
    ↓
弹出小卡片（inline，不是 modal）：
  ┌────────────────────────────────┐
  │ 哪个 RO 的零件到了？           │
  │ ○ RO#9448 Toyota Camry        │
  │ ● RO#9531 Tesla Model Y       │
  │                                │
  │ 备注（可选）: ___________      │
  │ [确认执行]  [取消]             │
  └────────────────────────────────┘
    ↓ 确认
GIB 执行 action → Toast 提示 "✅ 已更新 RO#9531 零件状态"
```

---

## Feature 2：Parts Manager 专属视图

Parts Manager 的 TaskBoard 不显示任务组，而是显示**零件状态看板**。

### 布局

```
┌─────────────────────────────────────────────────────┐
│  零件追踪  ·  5 个 RO 待处理                          │
│  [ 全部 ] [ 未下单 ] [ 已下单 ] [ 部分到货 ] [ 全到 ]  │
└─────────────────────────────────────────────────────┘

⚠️ ETA 已过 (2)
┌────────────────────────────────────────────────────┐
│  #9448  Toyota Camry  ·  ordered  ·  ETA 5/3 ⚠️   │
│  Parts Trader  ·  已过期 3 天                        │
│  [ 📦 全部到货 ]  [ ⏳ 更新 ETA ]  [ 加备注 ]        │
└────────────────────────────────────────────────────┘

📅 今天到 (1)
┌────────────────────────────────────────────────────┐
│  #9531  Tesla Model Y  ·  partially_received  ·  5/6│
│  [ 📦 全部到货 ]  [ 📦 部分到货 ]  [ 加备注 ]        │
└────────────────────────────────────────────────────┘

📆 本周到 (2)
...
```

### 数据排序优先级
1. ETA 已过（partsStatus ≠ all_received）— 红色警告
2. ETA 今天
3. ETA 明天到本周
4. 无 ETA 但未下单 — 橙色提示
5. all_received — 折叠到底部

### 信息展示（每行）
- RO# + 车型 + 客户名
- partsStatus badge
- ETA（来自 parts ETA 字段，待新增）或 RO 的整体 ETA
- 零件供应商（从最新 note 中提取，或新增 `partsVendor` 字段）
- 快速操作按钮（inline，不用打开 drawer）

---

## Feature 3：Body Man 视图增强

现有的 My ROs 卡片 + Daily Tasks 已经不错，这里做几处增强：

### My ROs 卡片上增加
- 零件状态 badge 放大一号，颜色更醒目（目前有，但偏小）
- 当 `partsStatus !== 'all_received'` 时，卡片左侧红色竖条换成橙色，并显示 "等零件" 文字

### Daily Tasks 卡片上增加
- 每个 task 旁边的 "Note" 按钮旁，加一个 **"🤖"** 按钮
- 点击 → 打开一个 mini GIB 面板，上下文已预填 RO# 和 task 标题
- 可以说"零件延迟了"、"已完成，等油漆" → GIB 解析 → 一键确认

---

## Feature 4：Painter 视图 — 今日/明日排程

Painter 的 My ROs 模块改为双列视图：

```
┌──────────────────┐  ┌──────────────────┐
│  今天要做 (2)     │  │  明天/后续 (3)    │
│                  │  │                  │
│  #9448 Camry     │  │  #9502 F-150     │
│  Paint prep ✓    │  │  Body complete   │
│  进油漆房 →      │  │  等待分配...      │
│                  │  │                  │
│  #9531 Tesla     │  │  #9601 Accord    │
│  In paint        │  │  ETA 5/9         │
└──────────────────┘  └──────────────────┘
```

分组逻辑：
- "今天"：ETA ≤ 今天 + 1 天，或 status 在 paint_prep/in_paint
- "后续"：ETA 在 2 天后，或 body_complete 等待开始

---

## 数据结构新增（可选）

```js
// RO 文档
partsVendor: 'Parts Trader' | 'LKQ' | 'OEM' | string  // 零件供应商
partsETA: '2026-05-08'  // 零件预计到货日期（独立于整车 ETA）
```

---

## 实现计划

### 改 TaskBoard.jsx
1. 在组件顶部根据 `role` 决定渲染哪个版本的快捷栏
2. 新增 `QuickActionBar` 组件（接收 role + assignedROs 作为 props）
3. 点击快捷按钮 → 调用 `parseShopInput` 或直接写 Firestore（简单操作不需要 GIB 绕一圈）

### 新增 PartsTrackerView 组件
- 只有 `role === 'parts_manager'` 时替换 Daily Tasks 模块
- 数据来源：`ros` 过滤掉 delivered，按零件紧急度排序

---

## 待讨论

- [ ] 快捷按钮是"全走 GIB 解析"，还是简单操作直接写 Firestore（更快，但少了 GIB 的智能注解）？
  - 建议：partsStatus 更新 → 直接写；复杂 note/多字段 → 走 GIB
- [ ] Parts Manager 视图需不需要新加 `partsETA` 和 `partsVendor` 字段？还是从 notes 里提取？
- [ ] Painter 的"今日/明日"分组 — 是否需要 painter 自己手动标"今天做这个"？
- [ ] GIB mini 面板（task 旁边的 🤖 按钮）是嵌在 TaskBoard 里，还是复用 FloatingAssistant？
