# MOTION — 维护入口

本页说明当前源码、受保护安装包、日常命令与数据保护。各版本原始报告与当时结论保存在 [历史索引](docs/history/README.md)，历史文字不代表当前状态。

## 1. 当前源码与安装包

本轮源码已完成六项维护修复：计划名称共用长度约束、Esc 取消同步父草稿、历史纠错离页保护、未知原生代次的计时恢复、仅首次播种，以及畸形 URL 和文件流失败时的服务健壮性。

上述六项维护修复已随 **0.1.8** 候选包构建（2026-10-30）；本轮训练编辑/删除/手势整合（统一编辑器、左滑删除、长按拖动排序、模板记忆与 v3 备份）已随 **0.1.9** 候选包构建（2026-11-02）。N01（持续休息通知正文点击回到应用）与 R01（未完成轮沿用上一完整轮）已随 **0.1.10** 完整 release 包构建（2026-11-15），但 **0.1.10 已被用户真机拒收**（G01 长按出现原生文本选择菜单与选择手柄，G02 删除操作/横幅为橙色而非红色），不作为验收通过。G01/G02 返工已随 **0.1.11 / versionCode 12** 完整 release 包构建（2026-11-15），**待 Codex 独立真机验收**。以上均**尚未经过真机验收**。源码检查、真实 DOM 回归、JVM 测试与构建验证都不等于手机实物验收；CI 目前仅有配置，没有远端运行通过的结论。

当前最新完整签名 release 候选包为 **0.1.19 / versionCode 20**（2026-11-18）。[MOTION-0.1.19-release.apk](apk/MOTION-0.1.19-release.apk)（4,235,678 字节，SHA-256 `cffb2df612c83f3c9d9448f907b1367e93a5f7d617ebe7d01211a48397bcb4db`）。本版合并趋势图实心红点和 Wave 3，包含完训时可选同步回原计划、历史纠错、渐进提示与配片速算，以及 PR 印章、小票 PNG 导出和历史月历。继续使用 `BackupPayload v3`。电脑端全量回归、Wave 3 Chrome 端到端 12 项及正式 APK 24 项检查通过。荣耀覆盖安装和 Android 系统文件选择器导出待真机验收。

上一完整签名 release 候选包为 **0.1.18 / versionCode 19**（2026-11-18）：针对 **0.1.17** 荣耀真机反馈完成 Wave 2 五项专项返工优化（保持 `BackupPayload v3` 100% 兼容）：① F09 左滑悬停松手删除调优（`380ms` 悬停、`78%` 位移比 + `40px` 左屏边缘感应、`48px` 拇指弧线容差，并修复滑入页面左 `16px` 边距后松手误取消）；② 统计页纯 SVG 趋势折线图补齐纵轴刻度与横轴中间日期刻度，支持点按任意数据点查看当次日期、重量与有效次数；③ 动作检索升级为 ICU 411 音节二分 + 前缀模糊匹配（同时支持 `WT`/`YT` 首字母与 `Wo`/`Wotui`/`Yin`/`Yinti` 不完整/全拼检索）；④ 计划日卡片置顶描边「完整编排」按钮、训练中卡片正面直露「编辑」按钮；⑤ 配置弹层（`ExerciseEditor` / `DropSetEditor`）智能跟随锁（改第 1 轮/组自动同步未单改后续轮/组，单改第 2/3 轮/组自动独立）及训练中首组正重量自动预填空白后续同阶段组。电脑阶段全套回归（类型检查、101 文件 1322 单测、24 项纯 JVM 原生测试、DOM 134、G1/G2/G04 14、Plans B4R2 19、F11/W02/G2A/R02/G3B/M02 全部专项及 0.1.18 真 Chrome 9 项端到端探针）与完整 Gradle debug+release 构建退出 0；实际 APK 23 项独立验签、16KB zipalign、编译布局 `MotionWebView`、内置资源及 38 个前置条目（含 0.1.15、0.1.16、0.1.17）零漂移校验通过。荣耀已抽测主要流程并提出趋势图红点反馈，首页备份提醒待真机触发（不能把电脑端检查当作真机 PASS），未公开发布。

上一完整签名 release 候选包为 **0.1.17 / versionCode 18**（2026-11-18）：[apk/MOTION-0.1.17-release.apk](apk/MOTION-0.1.17-release.apk)（**4,211,655 字节**，SHA256 `4e3534e1a13ead9d0162f96407fba8abd8f2dcb6a9a64241ba4e82ca503c0a6a`）保留原路径与原字节；完成 Wave 2 初始跨页逻辑弥合升级，用户真机实测提出五项优化要求，已由 0.1.18 返工收口。

上一已真机确认 release 包为 **0.1.16 / versionCode 17**（2026-11-18）：[apk/MOTION-0.1.16-release.apk](apk/MOTION-0.1.16-release.apk)（**4,203,245 字节**，SHA256 `9982baa61f6ef2bd06fe0fa23a694dde81f0d89046c29a5284b18e383c23ba5c`）保留原路径与原字节；针对 **0.1.15** 真机录屏反馈修复卡片松手回落文字残影与冷启动首次切底部 Tab 秒开，**用户已在荣耀真机安装实测确认顺滑通过**。

上一完整签名 release 候选包 **0.1.15 / versionCode 16**（2026-11-18）：[apk/MOTION-0.1.15-release.apk](apk/MOTION-0.1.15-release.apk)（**4,202,146 字节**，SHA256 `969e033031c043d4c73e4024d8f84f64e548fcaec57867e5f62496def5744c81`）保留原路径与原字节；完成 Wave 0 + Wave 1 全量优化，用户已在荣耀真机安装实测并反馈松手回落残影与首次切 Tab 短暂加载，已由 0.1.16 针对性收口。

上一已真机确认 release 包为 **0.1.14 / versionCode 15**（2026-11-18）：[apk/MOTION-0.1.14-release.apk](apk/MOTION-0.1.14-release.apk)（**4,187,477 字节**，SHA256 `1d0a8e696f11924ea9ac358fbe578893324b114ef72f13a05e2b98b91e16aa1e`）保留原路径与原字节；完成非输入区原生长按/`ActionMode`/`dispatchDragEvent` 三层门禁与手势协调器收敛优化，**用户已在荣耀真机安装确认长按拖动排序正常**。中间候选包 0.1.9–0.1.13 完整保留在本机磁盘供回滚，按 `.gitignore` 规则不重复入库。

上一完整签名 release 候选包 **0.1.13 / versionCode 14**（2026-11-17）：[apk/MOTION-0.1.13-release.apk](apk/MOTION-0.1.13-release.apk)（**4,184,602 字节**，SHA256 `c83544e426fa8aa12ebd5ed0c2f998a9ba62f98d8e4ef091f0ac8e386954d27f`）保留原路径与原字节；包含 W02 重量简化、M02 编辑替换动作带入上次记忆、G03 电脑多触点取消修复。

更早完整签名 release 候选包 **0.1.12 / versionCode 13**（2026-11-16）：[apk/MOTION-0.1.12-release.apk](apk/MOTION-0.1.12-release.apk)（**4,182,214 字节**，SHA256 `18c14a0feeefd3aae88f929df2e5cd0e61c2fff8b10efc1dc5b520d13dc054a4`）保留原路径与原字节；电脑验收通过，尚未安装手机，真机通知、文字选择菜单与拖拽等仍待验收。

| 项目 | 当前本地完整签名测试候选包 |
|---|---|
| 文件 | [apk/MOTION-0.1.18-release.apk](apk/MOTION-0.1.18-release.apk) |
| 版本 | versionName **0.1.18** / versionCode **19** |
| 大小 | **4,218,498 字节** |
| SHA256 | `b8cec0ee7755e267e2d8a9a4427bc97308faf603cc2d2d3fbbf608e567281679` |
| 包名 | `app.motion.personal` |
| 原生 origin | `https://localhost` |
| 签名证书 SHA256 | `d423bf800e7c275c5cd3c556912a7d64f08f78569675072de84925659fe964bb` |
| 定位 | 本地完整签名 release 候选包；电脑阶段 23 项验包通过，**待荣耀真机覆盖升级验收**；未公开发布 |

上一版本 **0.1.11 / versionCode 12**（[apk/MOTION-0.1.11-release.apk](apk/MOTION-0.1.11-release.apk)，4,173,989 字节，SHA256 `242dde8f802e97f4db4880f2484883e86e03872123943b8c5c3114833bbd1d24`）及其它旧包保留原路径与原字节。

历史 **0.1.9 / versionCode 10**（[apk/MOTION-0.1.9-release.apk](apk/MOTION-0.1.9-release.apk)，**4,138,326 字节**，SHA256 `59c4a39a874943d4f5b1ff5598d2385e9630ae486eed61630d176f37e4678b31`）保留原路径与原字节；0.1.8 及更早包同样保留原路径与原字节。保留旧包不表示可以直接覆盖降级。

[0.1.2 参考包](apk/MOTION-0.1.2-release.apk)继续保留原路径与原字节：versionCode **3**，**4,061,699 字节**，SHA256 `d4ed05a95ea2649066498b50aa6feafb3e69f58641f02d93f514c946dcb5d4a1`。保留旧包不表示可以直接覆盖降级。

## 2. 日常命令与输出

在 `app/` 内运行。依赖按提交的锁文件用 `npm ci` 安装；CI 约定 Node 24 / Java 21。真实 DOM 回归还需要可用的 Chrome；路径与证据目录通过脚本提供的环境变量配置。

| 命令 | 用途 |
|---|---|
| `npm ci` | 按锁文件重建依赖 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 全量单元测试（101 文件，1322 测试） |
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

新包 versionCode 必须递增：当前已构建候选包为 **19**（0.1.18），下一候选至少为 **20**。Android 会限制低版本覆盖，不应直接用旧 APK 降级或通过卸载绕过。确需回退时先明确数据备份、恢复方案与安装身份，再执行经确认的操作。

新包使用新文件名，不能覆盖现有 0.1.16、0.1.15、0.1.14、0.1.13、0.1.12、0.1.11、0.1.10、0.1.9、0.1.8、0.1.7、0.1.2 或其他受保护材料。签名文件、密码、个人备份、缓存和浏览器 profile 不入版本库。

## 5. 真机结论与待验证范围

0.1.7 在同一荣耀手机上，用户将启动管理改为手动并确认三项开启后，短时无 USB 锁屏提醒复测通过；自动管理时曾失败。系统通知创建时间不等于用户听到或感到震动的延迟。

**0.1.10 已被用户真机拒收**（G01/G02，见上）；**0.1.11 待 Codex 独立真机验收**，不能把本地源码检查、DOM 回归或 JVM 测试当作真机 PASS。0.1.7 的上述结论只属于 0.1.7 与该次条件，不能沿用到新包。

该结果仅适用于当次设备与设置。深 Doze、长时计时、进程被杀、其他 OEM、真实输入法以及不同文件提供器/真实数据规模下的导出恢复仍需要相应实测。单元、JVM、Chrome 或旧模拟器记录都不能扩大这些结论。

## 6. 保留与历史导航

- `app/src/`、`app/test/`、`app/android/`、`app/public/`、锁文件及模板文档是维护输入。
- 历史 `dist`、`dist-v2`…`dist-v8`、既有 APK、`_rollback/`、`_archive/` 和本机保留的验证材料不因本次文档整理而移动或删除。
- `_rollback/v2-snapshot-20261021b/src/` 是历史迁移测试依赖，须与测试一起保留，不能把所有 rollback 当作可清理缓存。
- [历史索引](docs/history/README.md)提供本次整理前的 README/MAINTENANCE 原文与 SHA256；其中各阶段状态、命令与机器路径只作为当时证据。迁移和恢复背景另见 [GITHUB-SYNC-FOLLOWUP.md](GITHUB-SYNC-FOLLOWUP.md)。
