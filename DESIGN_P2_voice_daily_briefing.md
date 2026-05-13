# P2 — 语音更新 + 角色专属每日简报

> 目标：让一线工人（双手油漆/工具）也能零摩擦更新状态；让每个角色每天登录时立刻知道"我今天要做什么"。

---

## Feature 1：TaskBoard 语音快速更新

### 现状

`useAI.js` 里已经有 `transcribeWithWhisper`，Chat 页面也已经有语音录入（MediaRecorder + Whisper）。  
现在缺的是：**在 TaskBoard 的任务卡片上有语音入口**，而不只是在 Chat 或 Update 页面。

### 入口设计

在 TaskBoard 的每个 RO 任务组 header 右侧加一个麦克风按钮：

```
┌─────────────────────────────────────────────┐
│  RO#9448  Toyota Camry  · 2 tasks   [ 🎙 ]  │
│                                              │
│  ✅ Teardown             [Start] [Note]      │
│  ○ Body work pending     [Start] [Note]      │
└─────────────────────────────────────────────┘
```

也可以在 TaskBoard 顶部加一个全局录音按钮（适合 manager 快速批量更新）：

```
┌─────────────────────────────────────────────┐
│  My Tasks   [🎙 语音更新]                    │
└─────────────────────────────────────────────┘
```

### 交互流程

```
用户长按 [ 🎙 ] 或点击后说话
    ↓
MediaRecorder 录音（按住说 / 点一下开始、再点停止）
    ↓
Whisper 转文字（支持中英文混说）
    ↓
parseShopInput 解析 → 生成 actions
    ↓
弹出 action 确认卡片（和 Update 页面一样）
    ↓
用户确认 → 写 Firestore
```

### 上下文预填

如果是从某个 RO 的任务组内触发：
- 自动在 prompt 里注入当前 RO# 和状态
- 用户直接说"零件到了"或"body 完成了"，不用说 RO 号
- GIB 默认作用在当前 RO，如果检测到其他 RO 号则覆盖

如果是全局录音按钮触发：
- 用户需要说 RO 号（同现有 Update 页面行为）

### 技术实现

现有基础（Chat.jsx 已有）：
```js
const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
// ... chunks → blob → File
```

新增：
- `VoiceUpdateButton` 组件（复用 Chat 录音逻辑，独立封装）
- 接收 `roContext?: { roId, roNumber, status }` prop
- 录音完成 → 调用 `transcribeWithWhisper` → 调用 `parseShopInput`（注入 roContext）
- 返回 actions → 传给现有的 `AIInputBox` action 确认流程，或者 TaskBoard 内联确认

---

## Feature 2：角色专属每日简报（Login 后首屏 or Tasks 页顶部）

### 触发时机

用户打开 App 后，Tasks 页顶部出现一个**折叠的简报卡片**：

```
┌──────────────────────────────────────────────────────┐
│  🌅 早上好，Aaron — 今天 5/6                          │
│                                                      │
│  ● 你负责的 3 辆车                                    │
│    - RO#9448 Camry：零件全到，可以开始 body work ✅   │
│    - RO#9531 Tesla：body_work 进行中，ETA 5/8 ⚠️     │
│    - RO#9601 Accord：等零件（Part Trader ETA 5/7）   │
│                                                      │
│  ● 今天要完成的 tasks：2 个 active                    │
│                                                      │
│  [ 展开完整简报 ]                      [ 关闭 ✕ ]    │
└──────────────────────────────────────────────────────┘
```

### 各角色简报内容

#### Body Man
- 我今天在做的 RO + 当前状态
- 哪辆车零件已到、可以推进
- 哪辆车 ETA 临近（需要加快）
- 今天的 active tasks 数量

#### Painter
- 哪辆车 body_complete（可以开始 paint prep）
- 当前 in_paint 的 RO + 预计完工
- 今天/明天 ETA 的 RO 优先级排序

#### Parts Manager
- 今天 ETA 到的零件清单
- ETA 已过但还没收到的（需要追单）
- 昨天下单、预计今到的

#### Estimator
- 待授权的 RO 列表
- 待 supplement 跟进的 RO
- 今天 ETA 的车（是否需要联系客户）

#### Manager
- 全店概览：X 辆 active，Y 辆 overdue，Z 辆本周 ETA
- 需要关注的异常（零件超期、状态停滞超 3 天）
- 今日生产进度预测

### 生成方式

**方案 A：纯前端规则生成（无 AI，快速）**

```js
function generateDailyBriefing(role, uid, ros, tasks) {
  if (role === 'body_man') {
    const myRos = ros.filter(r => r.assignedBodyMan === uid && r.status !== 'delivered')
    const partsReady = myRos.filter(r => r.partsStatus === 'all_received' && r.status === 'waiting_parts')
    const overdue = myRos.filter(r => isOverdue(r.eta))
    const myTasks = tasks.filter(t => t.assignedTo === uid && t.status !== 'completed')
    return { myRos, partsReady, overdue, myTasks }
  }
  // ... 其他 role
}
```

优点：零 API 费用，即时显示，无网络延迟  
缺点：只是数据展示，没有 AI 的洞察和建议语言

**方案 B：轻量 GIB 生成（Sonnet，每天一次，可缓存）**

```js
// 每次登录只调用一次，结果缓存在 sessionStorage
const briefing = await askShopAssistant({
  messages: [{ role: 'user', content: `生成今天 ${name}（${role}）的工作简报，简洁，中文，最多5条` }],
  ros, employees
})
```

优点：有 AI 语气，能识别异常、给优先级建议  
缺点：消耗 token（但 Sonnet 很便宜），需要网络

**建议：先做方案 A，后期升级为 A+B 混合（规则兜底，AI 增强描述）**

---

## Feature 3：每周工作量报告（Manager 视角）

Manager 在 Settings 或 Admin 页面可以查看：

```
本周生产效率 (5/1 - 5/6)
────────────────────────────────
完成交车: 4 辆
在修: 8 辆
平均周期: 11.2 天
超期率: 25% (2/8)

按员工工作量:
Aaron Cruz (body_man): 3 辆在修, 2 辆完成
Israel Ramirez (painter): 5 辆在修, 2 辆完成

ETA 风险:
- RO#9531 Tesla: ETA 5/8, 目前 body_work ⚠️
- RO#9602 BMW: ETA 5/9, 等零件 ⚠️
```

这部分完全可以由 GIB `askShopAssistant` 生成 Markdown 报告，一键复制发微信群。

---

## 实现计划

### VoiceUpdateButton 组件
- 新文件：`src/components/VoiceUpdateButton.jsx`
- Props: `roContext?: { roId, roNumber, status }`, `onActionsReady: (actions) => void`
- 内部：复用 Chat.jsx 的 MediaRecorder 录音逻辑（提取成 `useVoiceRecorder` hook 更好）
- 录音完成 → `transcribeWithWhisper` → `parseShopInput` → 回调

### DailyBriefingCard 组件
- 新文件：`src/components/DailyBriefingCard.jsx`
- 使用规则引擎生成，不依赖 GIB（Phase 1）
- TaskBoard.jsx 顶部渲染，当天第一次看到时展开，之后折叠
- 用 `sessionStorage` 标记当天是否已展示过（防止每次刷新都全屏弹出）

### TaskBoard.jsx 改动
- 引入 `VoiceUpdateButton`（全局一个 + 每个 RO 组一个小的）
- 引入 `DailyBriefingCard`（顶部，折叠态）

---

## 待讨论

- [ ] 语音入口：全局一个大按钮（manager 风格），还是每个 RO 卡片都有小按钮（工人风格）？
- [ ] 简报触发时机：每次打开 App 都生成，还是只在当天第一次登录时？
- [ ] 简报语言：中文（方便工人），还是跟系统语言走？
- [ ] 是否需要 `useVoiceRecorder` hook？还是直接在 VoiceUpdateButton 里写？
- [ ] 每周报告放哪里？Manager 的 TaskBoard？还是 Admin 页面？
- [ ] 简报卡片的"展开完整简报"点了之后 → 是展开详细列表，还是打开 GIB 对话框？
