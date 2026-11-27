#!/usr/bin/env node
/* MOTION · Android 打包流水线（一条命令可复现）。
   ── 步骤 ────────────────────────────────────────────────────
     0. 前置静态自检与门禁（必须在任何 dist/public 清理或写入前通过）：
        a. ANDROID_HOME / ANDROID_SDK_ROOT 存在性与有效性校验
        b. TypeScript 类型检查（tsc）
        c. 全量单元测试（npm run test）
        d. 纯 JVM 原生 I/O 测试（npm run android:test:java）
        任何一项失败立即中止退出，绝不继续进行构建、清理或 cap sync。
     1. 用 MOTION_TARGET=android 构建到 **dist-android**（不覆盖 dist-web / 历史 dist）
     2. 清除 exFAT / Finder 产生的 AppleDouble（`._*`）与 .DS_Store
     3. npx cap sync android（把 dist-android 复制进 APK 的 assets/public）
     4. 静态自检：APK 资源里必须是最新构建、且 capacitor 配置无远程 server.url
        （任何自检失败立即中止退出，绝不继续执行 Gradle）
     5. Gradle 构建 debug / release（release 有签名配置才签），扫描 release APK 后再交付路径

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

function defaultRun(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, {
    cwd: opts.cwd ?? APP_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
  });
}

/** 递归删除 AppleDouble（._*）与 .DS_Store —— 只删这些元数据文件，不碰任何源码 */
export function stripAppleDouble(root) {
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

/**
 * 校验 Android SDK 环境变量与目录存在性（纯校验边界）
 */
export function resolveAndroidSdk(env = process.env, existsFn = existsSync) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (!sdk || !existsFn(sdk)) {
    return { ok: false, error: '未设置 ANDROID_HOME / ANDROID_SDK_ROOT，或路径不存在' };
  }
  return { ok: true, path: sdk };
}

/**
 * 校验打包前后静态资源与配置安全契约（纯校验边界）
 */
export function validateStaticAssets({ builtHtml, packedHtml, capacitorConfigContent }) {
  const errors = [];
  const builtScript = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(builtHtml || '')?.[1];
  const packedScript = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(packedHtml || '')?.[1];

  if (!builtScript) {
    errors.push('dist-android/index.html 里找不到入口脚本');
  } else if (builtScript !== packedScript) {
    errors.push(`APK 资源与本次构建不一致：${builtScript} vs ${packedScript}`);
  }

  if (/server\s*:/.test(capacitorConfigContent || '') && /url\s*:/.test(capacitorConfigContent || '')) {
    errors.push('capacitor.config 里出现 server.url —— 禁止远程加载');
  }

  const remoteRefs = [...(packedHtml || '').matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
  if (remoteRefs.length) {
    errors.push(`打包 HTML 里仍有远程引用：${remoteRefs.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    builtScript: builtScript || null,
    packedScript: packedScript || null,
  };
}

/**
 * 前置门禁编排：按严格顺序执行 SDK 检查 → 类型检查 → 单元测试 → 纯 JVM 测试
 * 任何一步失败立即退出，不进入任何写入或清理流程
 */
export function runPreflightGate({ env = process.env, existsFn = existsSync, runFn = defaultRun } = {}) {
  log('0/5 前置门禁：Android SDK 路径存在性核查');
  const sdkCheck = resolveAndroidSdk(env, existsFn);
  if (!sdkCheck.ok) {
    throw new Error(sdkCheck.error);
  }
  ok(`ANDROID_HOME=${sdkCheck.path}`);

  log('0/5 前置门禁：TypeScript 类型检查（typecheck）');
  runFn('npm', ['run', 'typecheck']);
  ok('类型检查通过');

  log('0/5 前置门禁：全量单元测试（unit test）');
  runFn('npm', ['run', 'test']);
  ok('单元测试通过');

  log('0/5 前置门禁：纯 JVM 原生 I/O 测试（android:test:java）');
  runFn('npm', ['run', 'android:test:java']);
  ok('纯 JVM 测试通过');

  return { sdk: sdkCheck.path };
}

/**
 * 完整打包编排流程，便于在受控 fixture 下测试异常退出语义
 */
export function executeAndroidBuild({
  env = process.env,
  argv = process.argv,
  existsFn = existsSync,
  runFn = defaultRun,
  readFn = readFileSync,
  stripFn = stripAppleDouble,
  appDir = APP_DIR,
} = {}) {
  const wantRelease = argv.includes('--release');
  const distDir = join(appDir, 'dist-android');
  const androidDir = join(appDir, 'android');

  const buildRoot = env.MOTION_ANDROID_BUILD_DIR || join(env.HOME ?? '', '.motion-android-build');

  // 0. 前置门禁（在任何 dist/public 清理或写入前）
  const { sdk } = runPreflightGate({ env, existsFn, runFn });

  // 1. Web 构建（android 目标）
  log('1/5 构建 dist-android（MOTION_TARGET=android）');
  runFn('npx', ['vite', 'build'], {
    env: { MOTION_TARGET: 'android', MOTION_OUT_DIR: 'dist-android' },
  });

  const distHtmlPath = join(distDir, 'index.html');
  if (!existsFn(distHtmlPath)) {
    throw new Error('dist-android/index.html 不存在，构建失败');
  }
  if (existsFn(join(distDir, 'sw.js'))) {
    throw new Error('dist-android 里出现了 sw.js —— 原生包不应有 Service Worker');
  }
  ok('dist-android 已生成，且无 sw.js');

  // 2. 清 AppleDouble
  log('2/5 清理 exFAT/Finder 元数据（._* / .DS_Store）');
  const removedDist = stripFn(distDir);
  const removedAndroid = stripFn(androidDir);
  ok(`dist-android 清理 ${removedDist} 个，android/ 清理 ${removedAndroid} 个`);

  // 3. cap sync
  log('3/5 npx cap sync android');
  runFn('npx', ['cap', 'sync', 'android']);
  const removedAfterSync = stripFn(androidDir);
  if (removedAfterSync) ok(`cap sync 后再清理 ${removedAfterSync} 个元数据文件`);

  // 4. 静态自检（所有静态自检失败立即中止，不能继续 Gradle）
  log('4/5 静态自检（打包资源 = 本次构建，且无远程 server.url）');
  const assetsPublic = join(androidDir, 'app/src/main/assets/public');
  const packedHtmlPath = join(assetsPublic, 'index.html');
  if (!existsFn(packedHtmlPath)) {
    throw new Error('android/app/src/main/assets/public/index.html 不存在（cap sync 未生效）');
  }

  const builtHtml = readFn(distHtmlPath, 'utf8');
  const packedHtml = readFn(packedHtmlPath, 'utf8');
  const cfg = readFn(join(appDir, 'capacitor.config.ts'), 'utf8');

  const checkResult = validateStaticAssets({
    builtHtml,
    packedHtml,
    capacitorConfigContent: cfg,
  });
  if (!checkResult.ok) {
    throw new Error(`静态自检失败：\n${checkResult.errors.map((e) => '  ✘ ' + e).join('\n')}`);
  }
  ok(`APK 内的入口脚本就是本次构建产物：${checkResult.builtScript}`);
  ok('capacitor.config 无 server.url');
  ok('打包 HTML 无远程 URL 引用');

  // 5. Gradle 构建
  log('5/5 Gradle 构建');
  const gradlew = join(androidDir, 'gradlew');
  runFn(gradlew, [':app:assembleDebug', '--no-daemon'], {
    cwd: androidDir,
    env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
  });
  ok('assembleDebug 完成');

  const projectKey = motionProjectKey(androidDir);
  const appOut = join(buildRoot, projectKey, '_app/outputs/apk');
  if (wantRelease) {
    const signingDir = env.MOTION_SIGNING_DIR || join(env.HOME ?? '', '.motion-android-signing');
    const signed = existsFn(join(signingDir, 'keystore.properties'));
    if (signed) {
      ok('检测到签名配置，构建已签名 release');
    } else {
      console.log('  · 未发现签名配置（' + signingDir + '/keystore.properties），release 将未签名');
    }
    runFn(gradlew, [':app:assembleRelease', '--no-daemon'], {
      cwd: androidDir,
      env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
    });
    ok('assembleRelease 完成');
    const releaseApk = join(appOut, 'release', signed ? 'app-release.apk' : 'app-release-unsigned.apk');
    log('扫描 release APK 凭据');
    runFn('python3', [join(appDir, '../scripts/scan-credentials.py'), releaseApk]);
  }

  // 产物位置
  log('产物位置');
  console.log(`\n  构建目录指纹: ${projectKey}`);
  for (const [label, p] of [
    ['debug', join(appOut, 'debug/app-debug.apk')],
    ['release(unsigned)', join(appOut, 'release/app-release-unsigned.apk')],
    ['release(signed)', join(appOut, 'release/app-release.apk')],
  ]) {
    if (existsFn(p)) console.log(`  ${label}: ${p}`);
  }
  console.log('\n完成。');
}

// 生产执行入口（无绕过安全门禁的生产开关）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    executeAndroidBuild();
  } catch (err) {
    console.error(`\n  ✘ ${err.message}`);
    process.exit(1);
  }
}
