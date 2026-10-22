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

const SOURCES = [join(PLUGIN_DIR, 'BackupIo.java'), join(PLUGIN_DIR, 'ExportSpool.java')];
// 类全名（ExportSpoolTest 放在与插件相同的包里，才能访问包级测试钩子）
const TESTS = ['BackupIoTest', 'app.motion.personal.plugins.ExportSpoolTest', 'app.motion.personal.plugins.ExportPhaseTest', 'app.motion.personal.plugins.ExportOriginalBindingTest'];

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
