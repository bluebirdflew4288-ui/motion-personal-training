#!/usr/bin/env node
/* MOTION · Android 打包流水线（一条命令可复现）。
   ── 步骤 ────────────────────────────────────────────────────
     1. 用 MOTION_TARGET=android 构建到 **dist-android**（不覆盖 dist / dist-v2…dist-v8）
     2. 清除 exFAT / Finder 产生的 AppleDouble（`._*`）与 .DS_Store
        —— 这些文件会让 aapt2 把 `._drawable` 当成资源目录并直接失败
        （真实报错：'.../packageDebugResources/._drawable' is not a directory）
     3. npx cap sync android（把 dist-android 复制进 APK 的 assets/public）
     4. 静态自检：APK 资源里必须是最新构建、且 capacitor 配置无远程 server.url
     5. Gradle 构建 debug / release（release 有签名配置才签）

   用法：
     node scripts/build-android.mjs                 # 只构建 debug
     node scripts/build-android.mjs --release        # 也构建 release
   环境变量：
     ANDROID_HOME / ANDROID_SDK_ROOT  官方 SDK 位置
     MOTION_SIGNING_DIR               签名材料目录（默认 ~/.motion-android-signing，存在才签）
*/

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(APP_DIR, 'dist-android');
const ANDROID_DIR = join(APP_DIR, 'android');
const wantRelease = process.argv.includes('--release');

/**
 * 与 android/build.gradle 完全一致的构建目录指纹。
 *
 * Gradle 侧：
 *   key = <rootProject.name 清洗后前 24 字符>-<sha256(realpath(projectRoot)) 前 12 hex>
 * Node 侧必须用**同样的输入和算法**，否则脚本找不到刚构建出的 APK。
 * （rootProject.name 与 android 目录名一致，因此这里取 android 目录名。）
 */
export function motionProjectKey(androidDir) {
  const realRoot = realpathSync(androidDir);
  const digest = createHash('sha256').update(realRoot, 'utf8').digest('hex').slice(0, 12);
  let namePart = basename(realRoot).replace(/[^A-Za-z0-9._-]/g, '_');
  if (namePart.length > 24) namePart = namePart.slice(0, 24);
  return `${namePart}-${digest}`;
}

const log = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✔ ${m}`);
const fail = (m) => {
  console.error(`  ✘ ${m}`);
  process.exitCode = 1;
};

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { cwd: opts.cwd ?? APP_DIR, stdio: 'inherit', env: { ...process.env, ...opts.env } });
}

/** 递归删除 AppleDouble（._*）与 .DS_Store —— 只删这些元数据文件，不碰任何源码 */
function stripAppleDouble(root) {
  let removed = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (name.startsWith('._') || name === '.DS_Store') {
        try {
          unlinkSync(full);
          removed += 1;
        } catch {
          /* 只读文件跳过 */
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return removed;
}

// ── 1. Web 构建（android 目标）──────────────────────────────
// 注意：Capacitor 用**稳定的本地 origin**（https://localhost 由 WebView 内部拦截映射到
// 应用自带 assets），不是 file://。IndexedDB / localStorage 都挂在这个稳定 origin 下，
// 因此覆盖安装后数据仍在；这也正是不能依赖 http://192.168.* 或开发端口的原因。
log('1/5 构建 dist-android（MOTION_TARGET=android）');
run('npx', ['vite', 'build'], {
  env: { MOTION_TARGET: 'android', MOTION_OUT_DIR: 'dist-android' },
});
if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist-android/index.html 不存在，构建失败');
  process.exit(1);
}
ok(`dist-android 已生成（${readdirSync(join(DIST, 'assets')).length} 个 asset 文件）`);

// 原生包不注册 SW：构建脚本也不再生成 sw.js（build-sw.mjs 属 web 目标）
if (existsSync(join(DIST, 'sw.js'))) {
  fail('dist-android 里出现了 sw.js —— 原生包不应有 Service Worker');
} else {
  ok('dist-android 无 sw.js（原生包不注册 Service Worker，符合要求 A）');
}

// ── 2. 清 AppleDouble ──────────────────────────────────────
log('2/5 清理 exFAT/Finder 元数据（._* / .DS_Store）');
const removedDist = stripAppleDouble(DIST);
const removedAndroid = stripAppleDouble(ANDROID_DIR);
ok(`dist-android 清理 ${removedDist} 个，android/ 清理 ${removedAndroid} 个`);

// ── 3. cap sync ────────────────────────────────────────────
log('3/5 npx cap sync android');
run('npx', ['cap', 'sync', 'android']);
// cap sync 自己也可能引入 AppleDouble（写入时触发 Finder）
const removedAfterSync = stripAppleDouble(ANDROID_DIR);
if (removedAfterSync) ok(`cap sync 后再清理 ${removedAfterSync} 个元数据文件`);

// ── 4. 静态自检 ────────────────────────────────────────────
log('4/5 静态自检（打包资源 = 本次构建，且无远程 server.url）');
const assetsPublic = join(ANDROID_DIR, 'app/src/main/assets/public');
if (!existsSync(join(assetsPublic, 'index.html'))) {
  fail('android/app/src/main/assets/public/index.html 不存在（cap sync 未生效）');
} else {
  // 4a. 打包进 APK 的 index.js 名必须与实际构建产物一致
  const builtHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
  const packedHtml = readFileSync(join(assetsPublic, 'index.html'), 'utf8');
  const builtScript = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(builtHtml)?.[1];
  const packedScript = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(packedHtml)?.[1];
  if (!builtScript) fail('dist-android/index.html 里找不到入口脚本');
  else if (builtScript !== packedScript) fail(`APK 资源与本次构建不一致：${builtScript} vs ${packedScript}`);
  else ok(`APK 内的入口脚本就是本次构建产物：${builtScript}`);

  // 4b. 打包资源里不得含远程 server.url / LAN 地址
  const cfg = readFileSync(join(APP_DIR, 'capacitor.config.ts'), 'utf8');
  if (/server\s*:/.test(cfg) && /url\s*:/.test(cfg)) fail('capacitor.config 里出现 server.url —— 禁止远程加载');
  else ok('capacitor.config 无 server.url');

  // 4c. 打包后的 HTML/JS 不含 http(s) 外链引用（字体/样式全本地）
  const remoteRefs = [...packedHtml.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
  if (remoteRefs.length) fail(`打包 HTML 里仍有远程引用：${remoteRefs.join(', ')}`);
  else ok('打包 HTML 无远程 URL 引用');
}

// ── 5. Gradle 构建 ─────────────────────────────────────────
log('5/5 Gradle 构建');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk || !existsSync(sdk)) {
  fail('未设置 ANDROID_HOME / ANDROID_SDK_ROOT，或路径不存在');
  process.exit(1);
}
ok(`ANDROID_HOME=${sdk}`);

const gradlew = join(ANDROID_DIR, 'gradlew');
run(gradlew, [':app:assembleDebug', '--no-daemon'], { cwd: ANDROID_DIR, env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } });
ok('assembleDebug 完成');

if (wantRelease) {
  const signingDir = process.env.MOTION_SIGNING_DIR || join(process.env.HOME ?? '', '.motion-android-signing');
  if (existsSync(join(signingDir, 'keystore.properties'))) {
    ok('检测到签名配置，构建已签名 release');
  } else {
    console.log('  · 未发现签名配置（' + signingDir + '/keystore.properties），release 将未签名');
  }
  run(gradlew, [':app:assembleRelease', '--no-daemon'], { cwd: ANDROID_DIR, env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } });
  ok('assembleRelease 完成');
}

// ── 输出位置 ───────────────────────────────────────────────
log('产物位置');
// buildDir 已被重定向到 APFS（见 android/build.gradle），产物路径随之改变。
// 目录名必须用同一个指纹，否则同名项目的 APK 会互相覆盖 / 脚本找不到自己的产物。
const buildRoot =
  process.env.MOTION_ANDROID_BUILD_DIR || join(process.env.HOME ?? '', '.motion-android-build');
const projectKey = motionProjectKey(ANDROID_DIR);
// Gradle 的 project.path 为 ':' 时用 '_root'，为 ':app' 时替换 ':' 得到 '_app'
// ——必须与 android/build.gradle 的 buildDir 规则逐字一致，否则找不到产物。
const appOut = join(buildRoot, projectKey, '_app/outputs/apk');
console.log(`\n  构建目录指纹: ${projectKey}`);
for (const [label, p] of [
  ['debug', join(appOut, 'debug/app-debug.apk')],
  ['release(unsigned)', join(appOut, 'release/app-release-unsigned.apk')],
  ['release(signed)', join(appOut, 'release/app-release.apk')],
]) {
  if (existsSync(p)) console.log(`  ${label}: ${p}`);
}
if (process.exitCode) {
  console.error('\n构建过程中有失败项，见上面的 ✘');
} else {
  console.log('\n完成。');
}
