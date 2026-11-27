# MOTION — 维护入口

本页说明当前源码、受保护安装包、日常命令与数据保护。各版本原始报告与当时结论保存在 [历史索引](docs/history/README.md)，历史文字不代表当前状态。

## 1. 当前源码与安装包

本轮源码已完成六项维护修复：计划名称共用长度约束、Esc 取消同步父草稿、历史纠错离页保护、未知原生代次的计时恢复、仅首次播种，以及畸形 URL 和文件流失败时的服务健壮性。

上述六项维护修复已随 **0.1.8** 候选包构建（2026-10-30）；本轮训练编辑/删除/手势整合（统一编辑器、左滑删除、长按拖动排序、模板记忆与 v3 备份）已随 **0.1.9** 候选包构建（2026-11-02）。N01（持续休息通知正文点击回到应用）与 R01（未完成轮沿用上一完整轮）已随 **0.1.10** 完整 release 包构建（2026-11-15），但 **0.1.10 已被用户真机拒收**（G01 长按出现原生文本选择菜单与选择手柄，G02 删除操作/横幅为橙色而非红色），不作为验收通过。G01/G02 返工已随 **0.1.11 / versionCode 12** 完整 release 包构建（2026-11-15），**待 Codex 独立真机验收**。以上均**尚未经过真机验收**。源码检查、真实 DOM 回归、JVM 测试与构建验证都不等于手机实物验收；CI 目前仅有配置，没有远端运行通过的结论。

当前已验收的签名版为 **0.2.0 / versionCode 21**（2026-11-18）。[MOTION-0.2.0-release.apk](apk/MOTION-0.2.0-release.apk)（4,238,877 字节，SHA-256 `aff30ea4960f302a824332c2fdaa5695ee695d95915c39d8027b471f20a5f058`）。Wave 4 新增跨计划器械档位备忘、动感单车／椭圆机／划船机／自由有氧四种预设，以及可取消选中的训练日分部标签。全量备份导出为 v4，可恢复合法的 v1–v3 备份。共享计划模板可导入 v1 或 v2，新字段要求 v2。电脑端全量回归、Wave 4 浏览器验证 9 项和正式 APK 验包 25 项通过。用户已确认本版通过。

常用回滚版为 **0.1.19 / versionCode 20**（2026-11-18）。[MOTION-0.1.19-release.apk](apk/MOTION-0.1.19-release.apk)（4,235,678 字节，SHA-256 `cffb2df612c83f3c9d9448f907b1367e93a5f7d617ebe7d01211a48397bcb4db`）。本版合并趋势图实心红点和 Wave 3，包含完训时可选同步回原计划、历史纠错、渐进提示与配片速算，以及 PR 印章、小票 PNG 导出和历史月历。继续使用 `BackupPayload v3`。电脑端全量回归、Wave 3 Chrome 端到端 12 项及正式 APK 24 项检查通过。用户已试用并放行 Wave 4，具体真机细项未逐条确认。

对应的回滚源码为 Git 提交 `e1c675e`。更早的 APK 在本机 `_archive/maintenance-20261118-020/apk/`；路径与校验值见同目录上一级的 `MANIFEST.json`。详细的旧版本记录可查[整理前的维护说明](https://github.com/bluebirdflew4288-ui/motion-personal-training/blob/2809b5cdc61f5e8eea430c9fe32b83f135a1ad2f/MAINTENANCE.md)。

## 2. 日常命令与输出

在 `app/` 内运行。依赖按提交的锁文件用 `npm ci` 安装；CI 约定 Node 24 / Java 21。真实 DOM 回归还需要可用的 Chrome；路径与证据目录通过脚本提供的环境变量配置。

| 命令 | 用途 |
|---|---|
| `npm ci` | 按锁文件重建依赖 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 全量单元测试（103 文件，1348 测试） |
| `npm run android:test:java` | 原生逻辑的纯 JVM 测试（24 个 Java 测试类）；不需要手机或 Android SDK |
| `npm run android:apk:release` | 完整 Android 打包：SDK 检查 → 类型检查 → 全量单测 → JVM 测试 → `dist-android` → `cap sync` → 静态门禁 → Gradle debug/release；签名目录由 `MOTION_SIGNING_DIR` 指定 |
| `npm run test:dom` | 真实 DOM 关键缺陷回归测试（10 套件 134 项） |
| `npm run test:b4r2` | Plans 导航与管理选择独立性真实 Chrome 检验（19 项） |
| `npm run check` | 统一完整检查（类型检查 + 单元测试 + JVM 测试 + DOM 回归 + G1/G2 手势与删除 + Plans 导航） |
| `npm run build` | 常规 Web 构建与 Service Worker，输出 `dist-web/` |
| `npm run serve` | 默认服务 `dist-web/`；以终端打印的地址为准 |
| `npm run build:android` | Android 目标的 Web 资源，输出 `dist-android/`；不生成 APK |

常规 build、serve、preview 的默认目录保持一致。`MOTION_OUT_DIR` 可指定其他相对或绝对输出目录；Service Worker 必须写入同一构建目录。`MOTION_CHROME_PATH` 可覆盖 Chrome 执行路径，`MOTION_UI_EVIDENCE_DIR` 与 `MOTION_NATIVE_TEST_OUT` 可分别指定 UI 自动化与纯 JVM 测试的证据及编译临时输出目录，避免覆盖或污染历史构建与源码目录。

完整检查 `npm run check` 串联类型检查、全量单测、纯 JVM 测试、134 项 DOM 回归和 Plans 导航验证；具体入口以 `app/package.json` 与 CI 配置为准。JVM 测试证明纯 Java 逻辑，不能代替 Android Service、AlarmManager、通知渠道、锁屏或 OEM 的实际验证。

Android 完整打包需要 SDK 与必需检查先通过；失败时应在写入 `dist-android`、Capacitor `public` 或 APK 前停止，构建后自检失败也不得继续打包。实际生成、签名和安装新 APK 是独立的版本交付步骤。

## 3. 数据、备份与恢复

- 训练数据在用户设备的 IndexedDB，不随 GitHub 仓库或 Mac 源码自动备份。不得据源码、APK、合成测试数据或网页资源快照声称已备份用户手机数据。
- 更新、换机、卸载或清理前，在应用内「设置 → 导出 JSON 备份」，妥善保留文件。导入前核对预览中的计划数、训练记录数和来源信息；全量恢复会覆盖当前数据，不做合并。
- 恢复前快照只是应用内最近一次恢复的保护手段，不替代独立保存的备份文件。历史快照链不包含在常规备份内。
- 计划模板使用独立的 `motion-plan-template` 格式；完整备份为 `motion-training-backup`，二者不能互相替代。格式与示例见 [模板说明](docs/templates/plan-template-v1.md)。
- Web 数据空间由协议、域名和端口决定；换地址须通过备份迁移。Android 使用稳定的 `https://localhost` origin，改变 origin 会使原数据落在另一数据空间。

## 4. 升级与回退保护

新版本交付前，先保留当前包、当前构建资源和用户单独导出的 JSON 备份；三者用途不同。`dist` 或 `public` 的回滚副本只能恢复网页资源，不能恢复训练数据。

覆盖升级须同时保持：

1. 包名 `app.motion.personal`；
2. 同一长期 release 签名证书；
3. 原生 origin `https://localhost`。

**不要卸载后重装**：卸载或清除应用数据会删除本机数据库。0.1.7 的此前覆盖升级已由用户确认计划与历史保留；后续每个新包仍需逐次验证，不能沿用该结论。

新包 versionCode 必须递增：当前版本为 **21**（0.2.0），下一个安装包至少为 **22**。Android 会限制低版本覆盖，不应直接用旧 APK 降级或通过卸载绕过。确需回退时先明确数据备份、恢复方案与安装身份，再执行经确认的操作。

新包应使用新的版本号和文件名。回滚到 0.1.19 时，数据恢复需要升级前的 v3 备份。签名文件、密码、个人备份、缓存和浏览器 profile 留在本机。

### 凭据扫描

开发机须有 Python 3、`strings` 和 [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)。同步 GitHub 前，在完整克隆中提交本次变更，然后从仓库根目录运行 `python3 scripts/scan-credentials.py`。该命令检查可达提交和历史 APK。现有 CI 在 push 和 pull request 上复跑。

`npm run android:apk:release` 构建完成后会扫描本次生成的 release APK，覆盖解包资源、JS Bundle 和 DEX 字符串。上传 GitHub 或分发前，对最终待上传文件再运行 `python3 scripts/scan-credentials.py /path/to/MOTION-release.apk`。扫描失败即停止同步或发布。发现疑似凭据时在本机脱敏复核，确认泄露即撤销或轮换。


## 5. 真机结论与待验证范围

0.1.7 在同一荣耀手机上，用户将启动管理改为手动并确认三项开启后，短时无 USB 锁屏提醒复测通过；自动管理时曾失败。系统通知创建时间不等于用户听到或感到震动的延迟。

**0.1.10 已被用户真机拒收**（G01/G02，见上）；**0.1.11 待 Codex 独立真机验收**，不能把本地源码检查、DOM 回归或 JVM 测试当作真机 PASS。0.1.7 的上述结论只属于 0.1.7 与该次条件，不能沿用到新包。

该结果仅适用于当次设备与设置。深 Doze、长时计时、进程被杀、其他 OEM、真实输入法以及不同文件提供器/真实数据规模下的导出恢复仍需要相应实测。单元、JVM、Chrome 或旧模拟器记录都不能扩大这些结论。

## 6. 保留与历史导航

- `app/src/`、`app/test/`、`app/android/`、`app/public/`、锁文件及模板文档是维护输入。
- 本机旧安装包、旧构建和测试证据归档到 `_archive/maintenance-20261118-020/`。恢复位置见归档的 `MANIFEST.json`。
- `_rollback/v2-snapshot-20261021b/src/` 是历史迁移测试依赖，须与测试一起保留，不能把所有 rollback 当作可清理缓存。
- [历史索引](docs/history/README.md)提供本次整理前的 README/MAINTENANCE 原文与 SHA256；其中各阶段状态、命令与机器路径只作为当时证据。迁移和恢复背景另见 [GITHUB-SYNC-FOLLOWUP.md](GITHUB-SYNC-FOLLOWUP.md)。
