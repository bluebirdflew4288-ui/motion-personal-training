# MOTION — 继续维护入口

> 本文件是**唯一「继续维护」入口**。历史报告（`返工报告*.md`、`Android交付报告.md`、
> `HANDOFF-*.md`、`verify-*/`）全部保留原样，不覆盖、不改写。
> 最后整理：2026-10-22 19:05 CST

---

## 1. 当前唯一推荐安装包

| 项 | 值 |
|---|---|
| 路径 | `apk/MOTION-0.1.2-release.apk` |
| 版本 | versionName **0.1.2** / versionCode **3** |
| size | **4061699** |
| SHA256 | **d4ed05a95ea2649066498b50aa6feafb3e69f58641f02d93f514c946dcb5d4a1** |
| 包名 | `app.motion.personal` |
| 原生 origin | `https://localhost`（Capacitor 本地映射，非公网） |
| 签名证书 SHA256 | `d423bf800e7c275c5cd3c556912a7d64f08f78569675072de84925659fe964bb` |

旧版本包保留但**不再推荐**：
`MOTION-0.1.0-release.apk`、`MOTION-0.1.0-debug.apk`、`MOTION-0.1.1-release.apk`。

### 为什么推荐 0.1.2
0.1.2 修掉了 **Android 导出大备份时 App 自己退出、留下 0B 文件** 的缺陷。
旧 0.1.0 / 0.1.1 在约 2.6MB 备份上会触发 `TransactionTooLargeException`
（实测 parcel 11736560，两份 options 各 5866684）。详见
`verify-zero-byte/crash-stack-2mb.txt` 与 `verify-zero-byte/BUILD-REPORT-012.md`。

---

## 2. 覆盖升级原则（重要）

- **同包名 `app.motion.personal` + 同一长期 release 证书**才能覆盖安装并保住本地数据。
- **不要卸载再装**：卸载会清掉 IndexedDB，训练数据全部丢失。
- 正确做法：`adb install -r apk/MOTION-0.1.2-release.apk`（或直接点 APK 覆盖安装）。
- versionCode 必须递增（0.1.0=1 → 0.1.1=2 → 0.1.2=3），不能降级。

签名材料位置（**只记路径，不要读内容/不要贴密码**）：
`~/.motion-android-signing/`（`keystore.properties` + `motion-release.jks`）。
通过环境变量 `MOTION_SIGNING_DIR` 覆盖；该目录不在项目内、不进版本库、不进 APK。

---

## 3. 源码与测试

```
项目根：/Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app
应用目录：./app
```

| 命令 | 作用 |
|---|---|
| `cd app && npm test` | 全量单测（vitest） |
| `cd app && npx tsc --noEmit -p tsconfig.json` | 类型检查 |
| `cd app && node scripts/test-native.mjs` | 原生 Java I/O 纯 JVM 测试（自建 `android/native-test/out`，无需 SDK） |

### 原生 JVM 测试（4 个测试类，共 107 项）
```
app/android/native-test/BackupIoTest.java                 24 项
app/android/native-test/ExportSpoolTest.java              58 项
app/android/native-test/ExportPhaseTest.java              13 项
app/android/native-test/ExportOriginalBindingTest.java    12 项
```
运行 `node scripts/test-native.mjs` 会先 `javac` 编译源码与这 4 个测试类到
`android/native-test/out/`（该目录是**构建产物**，已忽略、不入库，每次自动重建），
再依次运行，全部通过时输出 `✔ 全部原生 I/O 测试通过`。

> 克隆仓库后若直接跑 `test-native.mjs` 报「找不到 BackupIoTest.java」，
> 说明这 4 个测试类缺失——它们必须随仓库提交，否则原生测试无法运行。
| **Web 构建（不覆盖历史）** | `cd app && MOTION_OUT_DIR=dist-web-next npm run build` |
| **Android 目标构建** | `cd app && npm run build:android`（输出 `dist-android`，无 SW） |
| **完整 Android 打包** | 见下方「发新版的完整顺序（仅模板，不要原样执行）」 |

> ⚠️ **不要**直接 `npm run build` 而不指定输出目录。
> 已核实真实默认值：`app/vite.config.ts:25` 与 `app/scripts/build-sw.mjs:12` 都是
> `process.env.MOTION_OUT_DIR || 'dist-v3'` —— 即**未指定输出时会覆盖历史 `app/dist-v3`**
> （v3 版本，仍在 5399 服务上），而不是覆盖 `app/dist`。
> 因此新 Web 构建请**显式**指定输出目录，例如
> `MOTION_OUT_DIR=dist-web-next npm run build`。
> 历史 `dist`、`dist-v2`…`dist-v8` 一律**不覆盖**。

### 发新版的完整顺序（**仅模板，不要原样执行**）

> 下面三段是**步骤模板**。变量用引号包裹的占位名表示（如 `"$NEW_VER"`），
> **不要**用尖括号写法（`<新版本>` 会被 shell 当成重定向）。
> 每一步都要自己确认路径真实存在，且目标不存在时才继续。

#### ① 先备份当前 0.1.2 的 `dist-android`（回滚点）

```bash
cd "/Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app"

NEW_VER="0.1.3"                      # ← 改成你要发的版本号（先不要改代码）
BACKUP_DIR="_rollback/dist-android-v${NEW_VER}-$(date +%Y%m%d)"

# 目标已存在 → 拒绝，不要覆盖已有回滚点
if [ -e "$BACKUP_DIR" ]; then echo "已存在，拒绝覆盖：$BACKUP_DIR"; exit 1; fi

cp -Rp app/dist-android "$BACKUP_DIR"
echo "已备份到 $BACKUP_DIR"
```

#### ② 改版本号并构建（**下次用户授权发新版时**才做）

```bash
cd "/Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app/app"

# 手工改 app/android/app/build.gradle：
#   versionCode  → 递增（0.1.2 是 3，下一版是 4）
#   versionName  → "0.1.3"

export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
export ANDROID_HOME=/Users/linyu/Library/Android/sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:/opt/homebrew/bin:$PATH"

node scripts/build-android.mjs --release
```

#### ③ 从 APFS 复制成新的 APK 文件名（目标存在则拒绝）

```bash
cd "/Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app"

NEW_VER="0.1.3"                      # ← 与 ② 保持一致
SRC_APK="$HOME/.motion-android-build/android-70e3f880cdf0/_app/outputs/apk/release/app-release.apk"
DST_APK="apk/MOTION-v${NEW_VER}-release.apk"

# 源必须存在；目标必须不存在（绝不覆盖 0.1.2）
if [ ! -f "$SRC_APK" ]; then echo "构建产物不存在：$SRC_APK"; exit 1; fi
if [ -e "$DST_APK" ]; then echo "已存在，拒绝覆盖：$DST_APK"; exit 1; fi

cp -p "$SRC_APK" "$DST_APK"
shasum -a 256 "$DST_APK"
```

> `apk/MOTION-0.1.2-release.apk` 必须始终保留，**不要被任何新包覆盖**。

### 三项保持一致（缺一不可）

覆盖安装后数据仍在，依赖以下**三项同时不变**：

1. **同包名** —— `app.motion.personal`（`applicationId` 不可改）
2. **同一长期 release 证书** —— `~/.motion-android-signing/` 不可更换
3. **原生 origin 保持 `https://localhost`** —— 由 `capacitor.config.ts` 的 `appId`
   与 Capacitor 本地映射共同决定；换 origin 会让 IndexedDB 落到不同源 → 数据「看不见」

三者任一变动，都会导致覆盖安装后数据丢失或不可见。

### 构建环境（已具备，免费工具链）
- Node：`/opt/homebrew/bin/node`
- JDK 21：`/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home`
- Android SDK：`/Users/linyu/Library/Android/sdk`（build-tools 36.0.0）
- Gradle 8.14.3（wrapper 自带，缓存在 `~/.gradle`）

### APFS 构建落点（关键）
源码在 **exFAT** 卷，Gradle 无法在其上写 xattr，因此构建输出被重定向到 APFS：
```
默认：$HOME/.motion-android-build/<项目指纹>/_app/outputs/apk/{debug,release}/
可用环境变量 MOTION_ANDROID_BUILD_DIR 覆盖
```
真实产物路径 = `~/.motion-android-build/android-70e3f880cdf0/_app/outputs/apk/release/app-release.apk`。
**不要**把构建输出改回 exFAT，否则 aapt2 会因 `._drawable` 报错。

### 历史测试的隐藏依赖（不要删）
`app/test/v4-backup.test.ts` 与 `app/test/v5-migrate-delete.test.ts` 会在运行时
**动态 import** `_rollback/v2-snapshot-20261021b/src/domain/`。
删掉或移动该快照会让这两条测试断链。`_rollback/` 全部快照都要保留。

---

## 4. 目录地图

| 路径 | 说明 | 可删？ |
|---|---|---|
| `app/src`、`app/test` | 生产源码与测试 | ❌ |
| `app/android/app/src` | 原生源码（含 `plugins/NativeFileBridgePlugin.java`、`ExportSpool.java`、`BackupIo.java`） | ❌ |
| `app/public` | 素材（字体/图片/图标） | ❌ |
| `app/node_modules` | 依赖（`npm ci` 可重建，但别随意删） | ⚠️ 可重建 |
| `app/package-lock.json` | 依赖锁 | ❌ |
| `apk/` | 4 个 APK（0.1.0 debug/release、0.1.1、0.1.2） | ❌ 全部保留 |
| `app/dist`、`app/dist-v2`…`dist-v8` | 历史 Web 构建，对应 5199–5899 服务 | ❌ |
| `app/dist-android` | 当前 Android 目标构建（与 0.1.2 APK 一致） | ❌ |
| `app/dist-baseline-011` | 0.1.1 时期浏览器验证用 Web 目标（非 Android） | ❌ 证据 |
| `_rollback/` | 全部历史快照（**含测试依赖**） | ❌ |
| `verify/`、`verify-v4`…`verify-v8`、`verify-android`、`verify-android-011`、`verify-plan-011`、`verify-zero-byte` | 验收报告/截图/JSON 证据 | ❌ |
| `_archive/maintenance-20261022/` | 本次整理的临时补丁/探针归档 | ⚠️ 见下 |

### Git 元数据位置（2026-10-22 迁移后）
活动 gitdir 在内置 APFS：
```
/Users/linyu/.local/share/agent-project-git/motion-personal-training.git
```
工作树仍在原 exFAT 项目目录；`.git` 是指向上述路径的指针文件。
旧的 `<项目根>/.git-motion/` 完整保留作为回滚来源（已忽略，勿删）。
迁移与回滚细节见 `GITHUB-SYNC.md` 第 3 节、`_archive/gitdir-migration-20261022/`。

### 本次归档的临时工作目录
原位于 `app/` 下的可重建临时物已归档（**未删除**）：
- `_archive/maintenance-20261022/temp-workdirs-20261022.tar.gz`（tar 包，SHA256 `3783ed2b03a345f274286aba5128abda2263af9958d31a3119b8685f68078a8c`）
- `_archive/maintenance-20261022/removed-from-tree/`（从工作树移走的原样副本）

包含：`app/.patch/`（9 个一次性源码补丁脚本）、`app/.probe/`（1 个像素定位探针）、
`app/.prevalidate.mjs`（fixture 预校验）、`app/android/native-test/out/`（JVM 编译产物）。
**这些都不是生产/测试脚本的依赖**（已用精确路径 grep 确认无引用），
且 `native-test/out` 每次运行 `test-native.mjs` 都会自动重建。

恢复命令（**安全做法：先解到新建空目录核验，不要直接覆盖当前项目**）：
```bash
cd "/Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app"

# 1) 解到新建的空目录（必须不存在，避免覆盖）
RESTORE_TMP="_archive/_restore-check-$(date +%Y%m%d-%H%M%S)"
[ -e "$RESTORE_TMP" ] && { echo "目标已存在，拒绝覆盖"; exit 1; }
mkdir -p "$RESTORE_TMP"
tar -xzf _archive/maintenance-20261022/temp-workdirs-20261022.tar.gz -C "$RESTORE_TMP"

# 2) 核验成员与哈希（对照 archive-member-manifest.txt）
find "$RESTORE_TMP" -type f ! -name '._*' | sort | while read f; do
  shasum -a 256 "$f"
done

# 3) 确认无误后，再按需拷回工作树
# cp -Rp "$RESTORE_TMP"/app/.patch app/
```

> 若坚持直接解包到项目，请用 `tar -k`（keep old files）：
> **已存在的文件会被跳过、不覆盖**，只补缺失文件。
> ```bash
> tar -kxzf _archive/maintenance-20261022/temp-workdirs-20261022.tar.gz -C .
> ```
> 注意 `-k` 的行为是「保留旧文件」，因此**不会**把归档版本覆盖到现有文件上；
> 若你想强制还原，必须先自行移走目标路径。

> `app/android/native-test/out/` **不需要**手工恢复：
> 下次运行 `node app/scripts/test-native.mjs` 会自动重建。

---

## 5. 回滚与验收路径

| 需要什么 | 去哪 |
|---|---|
| 回到 0.1.1 的 Android Web 资源 | `_rollback/dist-android-v0.1.1-20261022/`（28 文件） |
| 回到 0.1.0 的 Android Web 资源 | `_rollback/dist-android-v0.1.0-verified-20261022/`（28 文件） |
| 0.1.0 已验证的整份源码状态 | `_rollback/v0.1.0-verified-20261022/`（150 文件） |
| 历史各版本快照 | `_rollback/v2-snapshot-20261021b/` … `v8-snapshot-20261021h/` |
| 0B 导出缺陷的完整证据 | `verify-zero-byte/crash-stack-2mb.txt`、`logcat-repro-2mb.txt` |
| 0.1.2 构建与实证验收 | `verify-zero-byte/BUILD-REPORT-012.md` |
| 0.1.2 源码阶段三份报告 | `verify-zero-byte/SOURCE-STAGE-REPORT{,-r2,-r3}.md` |
| 0.1.1 模拟器验收 | `verify-android-011/HANDOFF-011.md`、`RESULTS-011-r2.md` |
| 0.1.0 Android 交付 | `Android交付报告.md`、`verify-android/` |

---

## 6. 数据与备份（重要认知）

- 训练数据存在**手机本机 IndexedDB**，不在 Mac 上。
- **手机本地数据不在 Mac 自动备份范围内。** 换机、卸载、清理应用数据都会丢。
- 唯一的可靠备份方式是 App 内「设置 → 导出 JSON 备份」，导出到手机本地文件。
- **本次验收用的导出样本全部是合成数据**（`verify-zero-byte/fixture-*.json`、
  `exported-012-*.json`），由本机自产的合法备份派生，不包含用户真实训练内容。
- **本轮没有读取、也没有备份用户真实手机数据库。**
- 因此：**不要声称 Mac 上已有用户手机数据备份。**

---

## 7. 验收范围与仍然待定的部分

### 已验证（0.1.2）
- 模拟器（`motion_api36` / Android 16 / API 36 / arm64）上：同一份 2.67MB 合成备份
  真实 SAF 导出**不再崩溃**，文件 **2676953 字节非 0B**，与源快照按 session.id
  **逐字段 0 处不一致**（222 sessions / 1776 exercises / 3552 sets）。
- 中文 / 7.5kg 小数重量 / 递减阶段小样本：真实导出后阶段结构与值全部保真。
- 覆盖升级 0.1.1→0.1.2 保数据（firstInstallTime 不变）。
- 取消导出：不产生文件、不更新「最近导出」、不崩溃。
- 构建产物：JS 入口 `index-BhmArsBk.js`，APK 内资源与 `dist-android` 逐文件一致，
  无 SW / 无 debuggable / 无远端 server.url。

### 未验证（需用户真机长期反馈）
- **真实手机上的导出行为**（厂商 SAF/provider 差异、真实数据规模）。
- 真实中文输入法组合输入、OEM 锁屏策略、厂商后台杀进程策略。
- Activity 重建 / 进程被系统杀死后的恢复结果通道（仅 JVM 替身与 JS 探针覆盖）。
- 慢速 SAF provider 读取期间重建。

> 结论边界：0.1.2 在模拟器上修复已实证，但**不能**据此声称用户真机问题已彻底解决，
> 需用户在自己的手机上覆盖安装后实测确认。

---

## 8. 维护时的注意事项

1. 改源码后务必跑 `npm test` + `npx tsc --noEmit -p tsconfig.json` + `node scripts/test-native.mjs`。
2. 重新打包走 `node scripts/build-android.mjs --release`，**不要**手工改 APK 或用旧 dist。
3. 每次新版本：改 `app/android/app/build.gradle` 的 versionCode/versionName，递增。
4. 不要删除 `_rollback/`（测试依赖）、不要删 `apk/` 旧包、不要动 `dist`～`dist-v8`。
5. 不要为「看起来干净」而清 AppleDouble（`._*`）——构建脚本会自己处理。
6. 不要用 `git clean`、不要全局 `rm` 通配删除。
