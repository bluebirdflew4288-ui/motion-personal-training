# 计划模板格式 `motion-plan-template` v1（第3阶段）

固定 JSON，用于**新增一个计划**。与全量备份 `motion-training-backup` 是两套格式，
互不通用：备份文件在模板入口会被拒绝并指路到「设置 → 备份与恢复 → 从文件恢复」。

## 顶层结构

```json
{
  "format": "motion-plan-template",
  "version": 1,
  "plan": { "name": "计划名", "days": [ /* 训练日，按数组顺序构成循环 */ ] }
}
```

- 只有**一个** `plan`；`days` 数组顺序就是循环顺序。
- **不要**写 `id / createdAt / updatedAt / cursor / revision / status / segments / elapsedMs`
  等内部字段——出现即拒绝。计划 ID、条目身份与时间、`cursor=0` 由 App 在**校验/解析（预览）阶段本地生成**，
  确认时再把这份预览对象**原子 insert**（不是"确认时才生成"）。
- 动作身份（`exerciseId`）按既有解析：预设动作命中稳定映射（如「双杠臂屈伸」→ `lib-chest-dip`），
  其余按规范化名称派生。跨 A/B、跨计划可比。

## 训练日 `days[i]`

| 字段 | 说明 |
|---|---|
| `name` | 日名称（必填） |
| `kind` | `train` 力量日 / `cardio` 有氧日 / `rest` 休息日（必填） |
| `focus` | `chest`/`back`/`legs`，**仅 train**，**可省略**（省略即不写该字段，**不隐式补 chest**） |
| `round` | `A`/`B`，**仅 train**，**可省略**（省略即不写该字段，**不隐式补 A**） |
| `restNote` | **仅 rest** 的说明文本 |
| `warmups` | **仅 train**，数组（可空） |
| `exercises` | **仅 train**，数组（可空） |
| `cardio` | **仅 cardio**，至少 1 项 |

不适用字段会被**严格拒绝**。对非力量日（cardio/rest），`warmups`/`exercises`/`focus`/`round` 等
**只要键出现就拒绝**——不论值是空数组、`null`、标量还是对象，绝不静默丢弃或重建为空；
力量日的合法**空数组**仍然可用，键完全缺省也合法。例如休息日带 `cardio`、有氧日带 `exercises:[]`
都会被拒并给出精确路径。

### 热身 `warmups[]`
`{ "name", "en"? , "unit": "reps"|"time"|"breath", "targetText", "optional"? }`

### 力量动作 `exercises[]`
`{ "name", "en"?, "restSec"?, "note"?, "target": {...} }`

- 普通组 `target.kind="straight"`：
  `{ sets, setsMax?, repsMin, repsMax, weightMode, suggestedWeightKg?, dumbbellBasis? }`
  · `weightMode`：`external`/`bodyweight`/`bodyweight_plus`/`assisted`
  · `dumbbellBasis`：`per_hand`/`total`
  · `suggestedWeightKg: 0` 是实际 0，`null`/缺省是未填。
- 递减组 `target.kind="dropSet"`：
  `{ rounds, stages: [{ weightKg?, repsMin?, repsMax?, toFailure }], restInSec, restAfterSec, weightMode, dumbbellBasis? }`
  · **阶段数 2–6**（= 编辑器能力；旧备份容忍到 12 不在此外溢）。
  · `toFailure:true` 的阶段不填次数范围；填了会拒绝。

### 有氧 `cardio[]`（只两预设，无自定义参数设计器；无目标时长/实际计时）
- 坡走：`{ "preset":"treadmill-incline", "name", "target": { "speedKmh", "inclinePct" }, "note"? }`
  · 速度 0–30，步长 0.1；坡度 0–40，步长 0.1。
- 爬楼：`{ "preset":"stair-climber", "name", "target": { "level" }, "note"? }`
  · 档位整数 1–100。

## 数值规则（一律明确拒绝，不静默猜/截断）
- 所有数字必须是 JSON number，不接受字符串。
- 次数/档位/组数/轮数/休息秒为整数；**速度、坡度按 0.1 步长**。
- **重量沿用现有编辑器精度**：有限数值 + 范围即可，允许 1.25 / 0.75 这类合法小配重，
  **不设 0.1 步长、不四舍五入、不截断**（普通建议重量与递减阶段重量同理）。
- 范围：组 1–30，次数 0–500，轮 1–20，阶段 2–6，建议重量 0–9999、阶段重量 0–999；
  **递减阶段间休息 `restInSec` 0–600**（沿用 DropSetEditor/validateDropDraft），
  **轮间休息 `restAfterSec` 0–3600**；动作 `restSec` 0–3600；
  日 ≤60，每日动作 ≤60，每日有氧 ≤8，轮×阶段 ≤200 行，计划 ≤200。
- 反向范围（次数下限>上限、组数上限<组数）拒绝。
- 旧备份校验层对阶段数（≤12）等更宽容，**不外溢**成模板新建能力。

## 导入行为（本地身份/时间与归属的真实时机）
1. 粘贴纯 JSON 或选择 `.json` 文件 → **先纯校验**（零写入），错误带可读位置（如 `plan.days[0].exercises[1].target.sets`）。
2. 校验通过即**在解析/预览阶段**由 App **本地构造**：计划与所有嵌套条目的 ID、`exerciseId`（走既有身份解析）、
   `createdAt/updatedAt`（取解析时刻 `Date.now()`）、`cursor=0` —— 这一步仍**零写入**，只是把骨架实例化为一份待确认的完整计划。
3. **只读预览**展示这份已实例化的计划（仍不落库）。
4. 确认 → 走 `atomicInsertPlan` 把**这份预览对象**一次 insert：**同事务**做容量（≤200）+ 同 id 拒绝 +
   同名默认拒绝（需明确勾选才并存），`add` 而非 `put`，失败/abort 整体回滚不留半份。
5. 只新增，绝不覆盖/合并旧计划；不改变当前 active 训练、历史、设置。可随后照常编辑。

**读回归属（G1）**：每一次异步读（文件 `text()` / 原生选择器）都归属"发起该读时那一轮"。
关闭重开、选新来源、手动改文本或点校验、开始确认都会让更早的在途读失效；成功/错误/取消三条返回
同样守代次 + 提交锁，晚到的读回既不覆盖新预览、也不重置提交状态或更换提交对象。
按钮与 handler 双重守卫，但不永久禁用入口（失败可重试，重新打开是干净的新轮次）。

完整可复制示例：同目录 `plan-template-v1.example.json`
（与 App 内「查看完整模板 / 复制示例模板」、`app/test/fixtures/`、解析器同一份）。
