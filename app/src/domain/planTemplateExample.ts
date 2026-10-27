/* 完整可复制示例模板（第3阶段）。
   · 与 docs/templates/plan-template-v1.example.json、app/test/fixtures/ 内副本
     **同一内容**（测试逐字段核对，防止示例/解析器漂移）。
   · UI「复制示例」与真实链测试都用这一份，不各写一份。
   · 覆盖：循环顺序/日名称、力量/有氧/休息三种日类型、热身、普通组、
     次数区间、建议重量与重量口径、递减轮/阶段（3 阶段，2–6 能力内）、
     休息秒数、备注；有氧两预设（坡走 + 爬楼），无目标时长/实际计时/segments。 */

export const EXAMPLE_PLAN_TEMPLATE = `{
  "format": "motion-plan-template",
  "version": 1,
  "plan": {
    "name": "示例：四日循环（力量+有氧+休息）",
    "days": [
      {
        "name": "胸 A",
        "kind": "train",
        "focus": "chest",
        "round": "A",
        "warmups": [
          {
            "name": "肩袖热身",
            "en": "Band Pull-Apart",
            "unit": "reps",
            "targetText": "2 × 15 次",
            "optional": true
          },
          { "name": "空杆卧推", "unit": "reps", "targetText": "1 × 20 次" }
        ],
        "exercises": [
          {
            "name": "双杠臂屈伸",
            "en": "Chest Dip",
            "restSec": 120,
            "target": {
              "kind": "straight",
              "sets": 4,
              "setsMax": 5,
              "repsMin": 8,
              "repsMax": 12,
              "weightMode": "bodyweight_plus",
              "suggestedWeightKg": 10,
              "dumbbellBasis": "total"
            },
            "note": "顶峰停留1秒，下放2秒"
          },
          {
            "name": "蝴蝶机夹胸",
            "restSec": 90,
            "target": {
              "kind": "dropSet",
              "rounds": 2,
              "stages": [
                { "weightKg": 40, "repsMin": 10, "repsMax": 12, "toFailure": false },
                { "weightKg": 30, "repsMin": 8, "repsMax": 10, "toFailure": false },
                { "weightKg": 20, "toFailure": true }
              ],
              "restInSec": 20,
              "restAfterSec": 120,
              "weightMode": "external"
            }
          }
        ]
      },
      {
        "name": "有氧爬坡",
        "kind": "cardio",
        "cardio": [
          {
            "preset": "treadmill-incline",
            "name": "有氧爬坡",
            "target": { "speedKmh": 5.5, "inclinePct": 12 },
            "note": "心率保持在燃脂区间"
          }
        ]
      },
      {
        "name": "背 B",
        "kind": "train",
        "focus": "back",
        "round": "B",
        "warmups": [],
        "exercises": [
          {
            "name": "正手宽握引体向上",
            "restSec": 150,
            "target": {
              "kind": "straight",
              "sets": 4,
              "repsMin": 6,
              "repsMax": 10,
              "weightMode": "bodyweight",
              "suggestedWeightKg": null
            }
          },
          {
            "name": "分体悍马划船",
            "restSec": 120,
            "target": {
              "kind": "straight",
              "sets": 3,
              "setsMax": 4,
              "repsMin": 10,
              "repsMax": 12,
              "weightMode": "external",
              "suggestedWeightKg": 45
            }
          }
        ]
      },
      {
        "name": "爬楼机",
        "kind": "cardio",
        "cardio": [
          { "preset": "stair-climber", "name": "爬楼机", "target": { "level": 8 } }
        ]
      },
      { "name": "休息", "kind": "rest", "restNote": "完全休息，可散步放松" }
    ]
  }
}`;
