# MOTION — 继续维护入口

> 本文件是**唯一「继续维护」入口**。历史报告（`返工报告*.md`、`Android交付报告.md`、
> `HANDOFF-*.md`、`verify-*/`）全部保留原样，不覆盖、不改写。
> 最后整理：2026-10-22 19:05 CST

---

## 1. 当前用户推荐测试包（本地候选，未发布）

| 项 | 值 |
|---|---|
| 路径 | `apk/MOTION-0.1.7-release.apk` |
| 版本 | versionName **0.1.7** / versionCode **8** |
| size | **4122041** |
| SHA256 | **675bf332266671cf8a4c4821442f076c81d272f24fc1bd71169327af015717d8** |
| 包名 / 原生 origin | `app.motion.personal` / `https://localhost` |
| 签名证书 SHA256 | `d423bf800e7c275c5cd3c556912a7d64f08f78569675072de84925659fe964bb` |
| 当前结论 | 用户认定 0.1.7 在本机较稳定。荣耀手机在手动启动管理、用户确认三项开启时，本次短时无 USB 锁屏复测通过；不是普遍 OEM/Doze/长时/进程死亡保证，也不是公开发布。详细边界见下方 0.1.7 记录。 |

### 上一代已验收参考包（保留，不是当前用户推荐测试包）

`apk/MOTION-0.1.2-release.apk`：versionName **0.1.2** / versionCode **3**，4,061,699 字节，SHA256 `d4ed05a95ea2649066498b50aa6feafb3e69f58641f02d93f514c946dcb5d4a1`。该 APK 继续保留原路径与原字节，供历史参考/回退判断。

本机保留 0.1.0–0.1.6 旧版、失败包或中间候选；除已跟踪的 0.1.2 外不上传、不覆盖。下方 0.1.3–0.1.6 阶段段落是各自时点的历史记录，原始状态文字保留，不代表当前状态。

### 当前稳定测试包：后台提醒有限修复（0.1.7 / versionCode 8）— **仅本地候选，未公开发布**
| 项 | 值 |
|---|---|
| 路径 / 版本 | `apk/MOTION-0.1.7-release.apk`；versionName **0.1.7** / versionCode **8**；包名 `app.motion.personal`；Capacitor origin `https://localhost`。 |
| 状态 | 源码阶段已由主Codex接受：正剩余时显式非零加/减时来源为 `user-adjust`；减时的 intentId 仍为 0，零调整仍为 `query`。源码回归与真实React开发/生产检查已通过。Root 授权覆盖安装成功，`installedAPK` SHA256 与本候选完全一致；`firstInstallTime` 保持 **2026-10-22 02:06:20**，用户确认原计划/历史仍在。此包为用户当前推荐测试包；仍属本地候选，非公开发布。0.1.2 是上一代已验收参考包。 |
| 真机提醒复测 | 同一荣耀手机、同一 0.1.7 APK：USB 锁屏时减时 15 秒通过，通知系统创建时间为 deadline **+11 ms**（只表示系统创建，不代表用户感知/震感时延）。应用启动管理为“自动管理”时，无 USB 锁屏复测 **FAIL**，接线后立即响。用户随后将 MOTION 启动管理改为“手动管理”并称三项均开启；同条件无 USB 锁屏约 60 秒复测通过，Root 抓到最终 deadline `1793112803727`、通知 id **257** 系统创建于 `1793112803753`（**+26 ms**，仅系统创建时间）。用户确认未接线、仍锁屏时按时提醒。**结论只适用于这台荣耀手机、手动管理设置与本次短时对照；不代表所有 OEM、深 Doze、长时计时或进程被杀情形均通过。** |
| APK / 签名 | size **4122041** / SHA256 `675bf332266671cf8a4c4821442f076c81d272f24fc1bd71169327af015717d8`；长期签名证书 SHA256 `d423bf800e7c275c5cd3c556912a7d64f08f78569675072de84925659fe964bb`。 |
| 构建与独立核验 | `node scripts/build-android.mjs --release`，2026-10-27 22:23:28.276–22:24:01.704 +08，原始进程自然退出 **0**。Root 独立 **22 项产物检查**与 **27 项资源逐字节匹配**均通过。完整stdout/stderr、输入清单、签名公开指纹与来源证据在 Codex Task `tasks/2026-10-27_motion-background-reminder-device-diagnosis/luna-candidate017/`。 |
| 回滚材料 | `_rollback/dist-public-v0.1.6-before-0.1.7-20261027T221924+0800/` 保存构建前 `app/dist-android` 27 项与 Capacitor `public` 29 项逐文件字节映射。旧 APK 保留原路径原字节。此回滚仅保存网页资源，不是训练数据备份。 |

> 以下 0.1.6、0.1.5、0.1.4、0.1.3 记录保留各阶段原有状态与证据；请以上方 0.1.7 当前说明作为当前推荐状态。

### 第5阶段本地候选包（0.1.6 / versionCode 7）— **本地测试候选，待主Codex独立实物验收，不是已发布**
| 项 | 值 |
|---|---|
| 路径 | `apk/MOTION-0.1.6-release.apk` |
| 版本 | versionName **0.1.6** / versionCode **7**；包名 `app.motion.personal` |
| 状态 | 源码状态 **SOURCE_ACCEPTED**：支持添加动作前先确认组数、目标次数和休息；支持从本次训练移除未记录动作；raw输入与保存失败重试受保护。问题一后台提醒延迟未修复。真实手机安装、覆盖升级与个人数据保留尚未验证；不能视为手机验收通过。正式推荐安装包仍为 0.1.2。 |
| 构建证据 | `node scripts/build-android.mjs --release` 于 2026-10-27 21:03:45 +08:00 启动，21:04:00 自然退出 **0**，日志无 `✘`。APK 来自既有 APFS release 输出 `/Users/linyu/.motion-android-build/android-70e3f880cdf0/_app/outputs/apk/release/app-release.apk`；aapt manifest 与 v2/v3 签名检查、public 资源逐字节核对均通过。完整日志、哈希与校验见 Codex Task `tasks/2026-10-27_motion-add-remove-supervision/luna-candidate016/`，待主Codex独立核验。 |
| APK | size **4122046** / SHA256 `e2ff621575abba0c67010b95787e522a66879495db1cab711424429a1e4cadae`；签名证书 SHA256 `d423bf800e7c275c5cd3c556912a7d64f08f78569675072de84925659fe964bb`。 |
| 回滚材料 | `_rollback/dist-public-v0.1.5-before-0.1.6-20261027T210300+0800/` 保存构建前 `app/dist-android` 27 项与 Capacitor `public` 29 项逐文件字节副本。此回滚仅用于 Web 构建资源，不是训练数据备份。0.1.5 及更早 APK 保留原路径原字节。 |

### 第4阶段本地候选包（0.1.5 / versionCode 6）— **本地测试候选，待独立实物验收，不是已发布**
| 项 | 值 |
|---|---|
| 路径 | `apk/MOTION-0.1.5-release.apk` |
| 版本 | versionName **0.1.5** / versionCode **6**（build.gradle 已递增） |
| size / SHA256 | 4117794 / `95027bbbbcbf2e38c9db3d6376ec39e6a12722e767647fe31b949bfff1b4015a` |
| 包名 / 证书 | `app.motion.personal` / 证书 SHA256 `d423bf80…9fe964bb`（与 0.1.2/0.1.3/0.1.4 同一长期证书） |
| 状态 | **本地测试候选**：Codex 源码必需链 158/158 PASS，源码稳定，实物构建自然退出 0、无 ✘，27 项 Web 资源逐字节一致，1013 旧产物严格保护（986 项原路径不变，27 项旧 0.1.4 dist 完整保真于新 rollback），tsc/vitest(902项)/native(710项)全过。待 Codex 独立实物验收；Android 真实覆盖升级、真机声震/后台仍 UNVERIFIED。 |
| 回滚材料 | 0.1.5 构建前 `app/dist-android` 完整快照：`_rollback/dist-android-v0.1.4-before-0.1.5-20261027T120232/`（27/27 逐 hash 核验两次，与旧 0.1.4 包 assets/public 一致）；旧 `apk/MOTION-0.1.4-release.apk`（保留作失败证据）、`apk/MOTION-0.1.3-release.apk`、`apk/MOTION-0.1.2-release.apk` 与历史备份保留作回退材料。**口径区分**：该 `_rollback/…` 目录只是**网页资源（dist）快照**，**不能恢复任何训练数据**；用户升级前请在应用内「设置 → 导出 JSON 备份」导出全量备份。**注意**：0.1.5/versionCode 6 安装成功后受 Android 防降级保护，不能直接用旧 release 覆盖降级；如确需回退，先明确数据恢复方案，本文不指示卸载或降级操作。 |
| 版本元数据 | 本轮 `Settings.tsx` 复用 `repo.ts` 的 `CURRENT_APP_VERSION`，显示与新导出备份 `appVersion` 对齐到 `0.1.5`；旧 1.0.0/0.1.3/0.1.4 备份仍按现有规则接受，版本差异**只提示不拒绝**。 |
| 构建 | `node scripts/build-android.mjs --release`（整 Node 自然退出 0、无 ✘ 项；日志 `verify-feedback/evidence-candidate015-20261027T120232/BUILD-RAW.log`）。详见 `verify-feedback/BUILD-CANDIDATE-015.md`。 |

### 第4阶段本地候选包（0.1.4 / versionCode 5）— **NOT ACCEPTED / 暂缓人工测试（已证6项有氧回退FAIL）**
| 项 | 值 |
|---|---|
| 路径 | `apk/MOTION-0.1.4-release.apk` |
| 版本 | versionName **0.1.4** / versionCode **5**（build.gradle 已递增） |
| size / SHA256 | 4117748 / `a0c444fc3d6951f1e6f2754d8cd7cc634aa23fdbca01a4370f4f27d7a380e2de` |
| 包名 / 证书 | `app.motion.personal` / 证书 SHA256 `d423bf80…9fe964bb`（与 0.1.2/0.1.3 同一长期证书） |
| 状态 | **实物验收 NOT ACCEPTED / 暂缓人工测试**：Codex 独立全链路实测该实物包抓到 6 条有氧参数在后续 clean action（完成/暂停继续/父结束/focus-blur）发生回退及虚假多开段缺陷（详见 Codex Task `evidence/FINAL014-CARDIO-FAILURE-ANALYSIS.md`）。该实物包保留原路径原字节，**不覆盖、不更名 final2、不作为正式交付包**。源码单点修复与回归已在工作区闭环（详见 `verify-feedback/CARDIO-CLEAN-ACTIONS-REPORT.md`），待 Codex 158 项独立重验通过后另行授权递增候选版本。当前正式推荐版本保持 **0.1.2** 不变。 |
| 回滚材料 | 0.1.4 构建前 `app/dist-android` 完整快照：`_rollback/dist-android-v0.1.3-before-0.1.4-20261027T015215/`（27/27 逐 hash 核验两次，与旧 0.1.3 包 assets/public 一致）；旧 `apk/MOTION-0.1.3-release.apk`、`apk/MOTION-0.1.2-release.apk` 与历史备份保留作回退材料。**口径区分**：该 `_rollback/…` 目录只是**网页资源（dist）快照**，**不能恢复任何训练数据**；用户升级前请在应用内「设置 → 导出 JSON 备份」导出全量备份。**注意**：0.1.4/versionCode 5 安装成功后受 Android 防降级保护，不能直接用旧 release 覆盖降级；如确需回退，先明确数据恢复方案，本文不指示卸载或降级操作。 |
| 版本元数据 | 本轮 `Settings.tsx` 复用 `repo.ts` 的 `CURRENT_APP_VERSION`，显示与新导出备份 `appVersion` 对齐到 `0.1.4`；旧 1.0.0/0.1.3 备份仍按现有规则接受，版本差异**只提示不拒绝**。 |
| 构建 | `node scripts/build-android.mjs --release`（整 Node 自然退出 0、无 ✘ 项；日志 `verify-feedback/evidence-candidate014-20261027T015215/BUILD-RAW.log`）。详见 `verify-feedback/BUILD-CANDIDATE-014.md`。 |

### 第4阶段本地候选包（0.1.3 / versionCode 4）— **待验收，不是已发布**
| 项 | 值 |
|---|---|
| 路径 | `apk/MOTION-0.1.3-release.apk` |
| 版本 | versionName **0.1.3** / versionCode **4**（build.gradle 已递增） |
| size / SHA256 | 4095181 / `bfe8d41b961f2e64821537da75929425a4928d74c37dabc16d3cd1f518feac23` |
| 包名 / 证书 | `app.motion.personal` / 证书 SHA256 `d423bf80…9fe964bb`（与 0.1.2 同一长期证书） |
| 状态 | **Codex 实际 APK/源码元数据/旧产物保护技术验收通过**（2026-10-25，证据见 Codex Task `VALIDATION-4-CANDIDATE.md`：版本/包名/长期证书/v2v3 签名/noDebug/noSW/noRemote、27 资源逐字节一致、旧 929 全保真+精确新增 28、最终 tsc/44 文件 655 通过）。**仍是本地测试候选**：Android 覆盖升级、前后台/锁屏/真机与用户接受**未验**，Qt CUA 入口缺口保持 UNVERIFIED。 |
| 回滚材料 | 0.1.3 构建前 `app/dist-android` 完整快照：`_rollback/dist-android-v0.1.2-before-0.1.3-20261025T010042/`（逐 hash 核验，与旧 0.1.2 包 assets/public 一致）；旧 `apk/MOTION-0.1.2-release.apk` 与上述升级前备份**保留作回退材料**。**口径区分**：该 `_rollback/…` 目录只是**网页资源（dist）快照**，**不能恢复任何训练数据**；"个人训练数据备份"专指用户升级前在 0.1.2 里「设置 → 导出 JSON 备份」导出的**全量备份文件**（在手机本地，Mac 上不自动存在），两者不可混同。**注意**：0.1.3/versionCode 4 安装成功后，不能直接用 code 3 的旧 release 覆盖降级（Android 按 versionCode 防降级，见下文覆盖升级原则与官方文档 <https://developer.android.com/studio/publish/versioning>）；如确需回退，先明确数据恢复方案（导出/恢复备份）再另行授权，本文不指示卸载或降级操作。 |
| 版本元数据 | 本轮 `Settings.tsx` 复用 `repo.ts` 的 `CURRENT_APP_VERSION`，显示与新导出备份 `appVersion` 由历史 `1.0.0` 对齐到 `0.1.3`；旧 1.0.0 备份仍按现有规则接受，版本差异**只提示不拒绝**。 |
| 构建 | `node scripts/build-android.mjs --release`（整 Node 退出 0、无 ✘ 项；日志 `verify-expansion/android-candidate-evidence/build-android-release.log`）。旧产物 929 文件保真 PASS。详见 `verify-expansion/BUILD-CANDIDATE-013.md`。 |

### 历史说明：0.1.2 为什么曾是推荐包
在 0.1.7 之前，0.1.2 曾是推荐参考包；它修掉了 **Android 导出大备份时 App 自己退出、留下 0B 文件** 的缺陷。
旧 0.1.0 / 0.1.1 在约 2.6MB 备份上会触发 `TransactionTooLargeException`
（实测 parcel 11736560，两份 options 各 5866684）。详见
`verify-zero-byte/crash-stack-2mb.txt` 与 `verify-zero-byte/BUILD-REPORT-012.md`。

---

## 2. 覆盖升级原则（重要）

- **同包名 `app.motion.personal` + 同一长期 release 证书**满足覆盖升级身份条件；本次 0.1.7 用户已确认原计划/历史保留，后续升级仍需逐次核验。
- **不要卸载再装**：卸载会清掉 IndexedDB，训练数据全部丢失。
- 当前用户测试包：`adb install -r apk/MOTION-0.1.7-release.apk`（或直接点 APK 覆盖安装）；0.1.2 作为上一代参考包保留。
- versionCode 必须递增（当前 0.1.7=8；若后续获授权发布新版本，下一 code 至少为 9），不能降级。

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
| `cd app && node scripts/ui-feedback-b4-check.mjs` 等 | 4 个真实 Chrome/DOM 施工者自查脚本；需 puppeteer-core 与 Chrome，不是独立验收 |

Chrome 路径默认使用 macOS Google Chrome；可用 `MOTION_CHROME_PATH=/path/to/chrome` 覆盖。手机添加/移除自查的证据默认写到 `app/verify-feedback/phone-add-remove-20261027/`，可用 `MOTION_UI_EVIDENCE_DIR=/path/to/output` 覆盖。自查 profile/证据属于本机材料。

### 当前原生 JVM 测试（22 个测试类）

`node scripts/test-native.mjs` 编译并执行当前 `app/android/native-test/` 中的 22 个测试类，覆盖导出/备份与休息提醒原生边界。测试类与插件源码必须一并入库；编译输出 `android/native-test/out/` 已忽略且每次重建。早期维护记录里的“8 类 / 216 项”只代表当时的历史测试集，不是当前汇总。

> 克隆仓库后若直接跑 `test-native.mjs` 报「找不到 BackupIoTest.java」，
> 说明这些测试类缺失——它们必须随仓库提交，否则原生测试无法运行。
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

#### ① 先备份当前 0.1.7 的 `dist-android`（回滚点）

```bash
cd "/Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app"

NEW_VER="0.1.8"                      # ← 当前 0.1.7/code 8 后的下一候选示例（先不要改代码）
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
#   versionCode  → 递增（当前 0.1.7 是 8，下一版至少是 9）
#   versionName  → "0.1.8"

export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
export ANDROID_HOME=/Users/linyu/Library/Android/sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:/opt/homebrew/bin:$PATH"

node scripts/build-android.mjs --release
```

#### ③ 从 APFS 复制成新的 APK 文件名（目标存在则拒绝）

```bash
cd "/Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app"

NEW_VER="0.1.8"                      # ← 与 ② 保持一致
SRC_APK="$HOME/.motion-android-build/android-70e3f880cdf0/_app/outputs/apk/release/app-release.apk"
DST_APK="apk/MOTION-v${NEW_VER}-release.apk"

# 源必须存在；目标必须不存在（绝不覆盖 0.1.2）
if [ ! -f "$SRC_APK" ]; then echo "构建产物不存在：$SRC_APK"; exit 1; fi
if [ -e "$DST_APK" ]; then echo "已存在，拒绝覆盖：$DST_APK"; exit 1; fi

cp -p "$SRC_APK" "$DST_APK"
shasum -a 256 "$DST_APK"
```

> `apk/MOTION-0.1.2-release.apk` 与 `apk/MOTION-0.1.7-release.apk` 都必须保留原字节，**不要被任何新包覆盖**。

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

### 计划模板导入（第3阶段，BRIEF 第5项）

- **格式文档与完整示例**：`docs/templates/plan-template-v1.md`、
  `docs/templates/plan-template-v1.example.json`。这三份（文档 / 示例文件 /
  App 内嵌 `src/domain/planTemplateExample.ts`）内容**必须一致**，
  `test/p3-template-import.test.ts` 会逐字节核对示例文件与内嵌常量，防漂移。
- **解析/校验/预览**（纯函数，零写入）：`app/src/domain/planTemplate.ts`。
  独立格式 `motion-plan-template` v1，与全量备份 `motion-training-backup` **不互通**
  （备份误投会被拒绝并指路到恢复入口）。
  · 时机如实：`parsePlanTemplate` 校验通过即调用 `instantiatePlan`，**在解析/预览阶段本地构造**
    ID/`exerciseId`/时间/`cursor=0`（`createdAt/updatedAt` 取解析时刻）；确认只是把该预览对象
    原子 insert，**不是**"确认时才生成身份/时间"。
  · **G2（REVIEW-3）按 kind 分别把握**：`warmups`/`exercises` **仅 train** 可出现（必须提供，可为空数组）；
    `focus`/`round` **仅 train**；`cardio` **仅 cardio 日**允许（且至少 1 项）；`restNote` **仅 rest 日**允许。
    对不适用类型，这些键**只要出现就拒绝**——空数组/null/标量/对象都拒，不静默丢弃、不重建为 []。
    别把所有非力量日可选键写成一概禁止（cardio 允许 cardio、rest 允许 restNote）。
  · **G3（REVIEW-3）**：重量沿用编辑器精度（有限+范围即可，1.25/0.75 合法，**不施加 0.1 步长**；
    速度/坡度 0.1 与爬楼整数仍是审定规则）；`restInSec` 上限 **`MAX_REST_IN_SEC`(600)**，
    与 DropSetEditor/validateDropDraft 一致；`restAfterSec` 才是 0–3600。
- **唯一写入路径**：`app/src/db/tx.ts` 的 `atomicInsertPlan`（insert-only）。
  · **不要**改用 `savePlan`/`upsertPlan` 落模板：那是 upsert，会覆盖同 id 旧计划。
  · 同事务内做容量（`MAX_PLANS=200`）、同 id 拒绝、同名默认拒绝（需明确 allowDuplicateName 才并存）、
    用 IDB `add`（非 `put`）兜底，失败/abort 整体回滚。
- **入口 UI**：`app/src/ui/TemplateImportSheet.tsx`，挂在计划页「+ 新建 → 导入计划模板（JSON）」。
  流程固定为 校验 → 只读预览 → 确认一次 insert；预览/校验阶段绝不写库。
  · **G1（REVIEW-3）读回归属**：`genRef` 代次 + `activeRef`/`submittedRef` 提交锁（都用 ref，
    异步回调读当下值而非陈旧闭包）。每次异步读（Web `file.text()` / 原生 `pickBackupViaNative`）
    **自取新代次**；关闭重开（open 边沿 effect 复位）、选新来源、手动改文本/点校验、开始确认
    都让更早的在途读失效。成功/错误/取消三条返回都要过代次 + 提交锁：晚到读回不覆盖新预览、
    不重置 submitted、不换提交对象（确认在途期间预览/提交内容稳定）。
    按钮 + hidden input 在 busy/submitted 禁用，与 handler 守卫双保险；不永久禁用入口。
    成功路径**不**调 resetAll（防提交后晚到读回又进预览）；下一轮干净状态由 open 边沿复位。
- **上限/单位一律引用 `src/domain/limits.ts` 唯一真源**（速度 0–30 步长 0.1、坡度 0–40 步长 0.1、
  档位整数 1–100、组 1–30、次 0–500、轮 1–20、建议重量 0–9999/阶段重量 0–999（**无步长限制**）、
  restInSec 0–600、restAfterSec/restSec 0–3600、日 ≤60、动作 ≤60/日、有氧 ≤8/日、轮×阶段 ≤200 行、
  计划 ≤200；递减阶段 **2–6=编辑器能力**；备份校验层容忍 12 阶段只保护旧数据，
  不外溢成模板新建能力）。
- **可移植测试 fixture**：`app/test/fixtures/` 放两份**纯合成/示例**JSON：
  · `plan-template-v1.example.json`（本项目示例，与 docs 同内容）
  · `synthetic-v1-backup.json`（Codex 冻结 v1 fixture 的**逐字节副本**，
    SHA256 `d44f6307227ed79929648dcb6fb7f839246731788cc126ee69c2b15d4fa8fd36`；
    原件在 Codex Task 未改，测试用相对 `import.meta.url` 读取并自校验哈希，
    不再硬编码另一 Workspace 的私有路径）。
- **真实浏览器自查**：`app/scripts/ui-template-import-check.mjs`
  （项目内 esbuild+puppeteer-core，真实 main.tsx/Store/原生 IDB，只读驱动 DOM）。
  运行 `/opt/homebrew/bin/node scripts/ui-template-import-check.mjs`，
  产物落 `app/verify-self/ui-template-import/`。这是**施工者自查**，非 Codex 独立合约。
  注意 ensureSeed 会在空库时播种 1 条 V3.2，因此用例基线恒为 1，别假设 0。

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
