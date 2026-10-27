#!/usr/bin/env node
/* 原生 Java I/O 的纯 JVM 测试（不需要 Android SDK / Gradle / 设备）。
   直接编译 android/app/src/main/java/.../{BackupIo,ExportSpool}.java
   与 native-test/*.java，再用普通 java 运行。
   这是 A01/A02 缺陷与 0.1.2 TransactionTooLarge 修复的可复现证据。 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(APP_DIR, 'android/native-test');
const OUT = join(TEST_DIR, 'out');
const PLUGIN_DIR = join(APP_DIR, 'android/app/src/main/java/app/motion/personal/plugins');

const SOURCES = [
  join(PLUGIN_DIR, 'BackupIo.java'),
  join(PLUGIN_DIR, 'ExportSpool.java'),
  // 需求 2：休息提醒的参数解析 / 身份状态机 / 持久化门禁（纯 JVM，不依赖 Android API）
  join(PLUGIN_DIR, 'RestArgs.java'),
  join(PLUGIN_DIR, 'RestCallArgs.java'),
  join(PLUGIN_DIR, 'RestReminderState.java'),
  join(PLUGIN_DIR, 'RestReminderGate.java'),
  // G2：最小本地有界诊断（纯 JVM 编码/有界/脱敏，不依赖 Android API）
  join(PLUGIN_DIR, 'RestDiagLog.java'),
  // A2：当前段前台增强的纯决策逻辑（资格/锁时限/类型，不依赖 Android API）
  join(PLUGIN_DIR, 'RestForegroundPolicy.java'),
  // B3：设置跳转受限目标（纯 JVM 安全判定）
  join(PLUGIN_DIR, 'RestSettingsTargets.java'),
  // B4-R3：已确认落盘的视图（commit 失败不回滚内存 → 读回真值而不是失败候选）
  join(PLUGIN_DIR, 'RestDurableView.java'),
  join(PLUGIN_DIR, 'RestDurableFlag.java'),
];
// 类全名（ExportSpoolTest 放在与插件相同的包里，才能访问包级测试钩子）
const TESTS = ['BackupIoTest', 'app.motion.personal.plugins.ExportSpoolTest', 'app.motion.personal.plugins.ExportPhaseTest', 'app.motion.personal.plugins.ExportOriginalBindingTest', 'app.motion.personal.plugins.RestArgsTest', 'app.motion.personal.plugins.RestStateTest', 'app.motion.personal.plugins.RestGateTest', 'app.motion.personal.plugins.RestCallArgsTest',
  // G1/G2 回归：排程回复身份完整性与诊断编码
  'app.motion.personal.plugins.RestScheduleReplyTest',
  'app.motion.personal.plugins.RestDiagTest',
  // A2：A 批五项缺口返修 + 当前段增强决策
  'app.motion.personal.plugins.RestA2ReplyTest',
  'app.motion.personal.plugins.RestForegroundPolicyTest',
  // A2 补充验收边界：单调 deadline / 取消按钮身份 / 旧段收尾 / 独立通知 id
  'app.motion.personal.plugins.RestA2BoundaryTest',
  // A3：八项 FGS 控制流缺口（exact 回归/来源/取消归属/收束/渠道/锁/通知ID）
  'app.motion.personal.plugins.RestA3Test',
  // B3：设置跳转受限目标契约
  'app.motion.personal.plugins.RestSettingsNavTest',
  // B4-R2：已 fired 后用户明确新意图的新身份 / 旧请求重放拒绝（身份守卫）
  'app.motion.personal.plugins.RestIntentIdentityTest',
  // B4-R2：入口目标截止扣掉 JS→Plugin 排队耗时（不再 now+remainingMs）
  'app.motion.personal.plugins.RestIngressDeadlineTest',
  // B4-R3 D2：非法/过期/旧意图只拒绝自己，不破坏当前好提醒
  'app.motion.personal.plugins.RestR3DeadlineTest',
  // B4-R3 F2/O3：commit 失败 ≠ 内存回滚（真实 Android 边界）
  'app.motion.personal.plugins.RestR3DurableTest',
  // B4-R3 closure：显式 JSON null 截止 + 新 token 连续编号作用域
  'app.motion.personal.plugins.RestR3ClosureTest',
  // B4-R3 closure2：−15 经精确取消保留水位 + D1 目标墙钟/单调截止换算
  'app.motion.personal.plugins.RestR3Closure2Test',
  // B4-R3 legacy-lineage：旧原生数据无 lastIntentToken 键时的归属兼容与单点正规化
  'app.motion.personal.plugins.RestLegacyLineageTest'];

for (const s of SOURCES) {
  if (!existsSync(s)) {
    console.error(`找不到 ${s}`);
    process.exit(1);
  }
}
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const testFiles = TESTS.map((t) => join(TEST_DIR, `${t.split('.').pop()}.java`)).filter((p) => {
  if (!existsSync(p)) {
    console.error(`找不到测试 ${p}`);
    process.exit(1);
  }
  return true;
});

console.log('▶ 编译原生 I/O 源码 + 测试（纯 JVM）');
execFileSync('javac', ['-d', OUT, ...SOURCES, ...testFiles], { stdio: 'inherit' });

let failed = 0;
for (const t of TESTS) {
  console.log(`\n▶ 运行 ${t}`);
  try {
    execFileSync('java', ['-cp', OUT, t], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}

if (failed) {
  console.error(`\n✘ ${failed} 个原生测试类失败`);
  process.exit(1);
}
console.log('\n✔ 全部原生 I/O 测试通过');
