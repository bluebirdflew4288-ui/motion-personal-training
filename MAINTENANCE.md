# MOTION — 维护入口

本页说明当前源码、受保护安装包、日常命令与数据保护。各版本原始报告与当时结论保存在 [历史索引](docs/history/README.md)，历史文字不代表当前状态。

## 1. 当前源码与安装包

本轮源码已完成六项维护修复：计划名称共用长度约束、Esc 取消同步父草稿、历史纠错离页保护、未知原生代次的计时恢复、仅首次播种，以及畸形 URL 和文件流失败时的服务健壮性。

这些修改已随 **0.1.8** 候选包构建（2026-10-30），但**尚未经过真机验收**。源码检查、真实 DOM 回归、JVM 测试与构建验证都不等于手机实物验收；CI 目前仅有配置，没有远端运行通过的结论。

| 项目 | 当前本地测试候选包 |
|---|---|
| 文件 | [apk/MOTION-0.1.8-release.apk](apk/MOTION-0.1.8-release.apk) |
| 版本 | versionName **0.1.8** / versionCode **9** |
| 大小 | **4,124,667 字节** |
| SHA256 | `4222f91e5b2cc8adbba6b4fa9bee85c565f075974d917ce9680acf03e1c2b90d` |
| 包名 | `app.motion.personal` |
| 原生 origin | `https://localhost` |
| 签名证书 SHA256 | `d423bf800e7c275c5cd3c556912a7d64f08f78569675072de84925659fe964bb` |
| 定位 | 本地测试候选包；未真机验收，不是公开发布 |

上一版 **0.1.7 / versionCode 8**（[apk/MOTION-0.1.7-release.apk](apk/MOTION-0.1.7-release.apk)，**4,122,041 字节**，SHA256 `675bf332266671cf8a4c4821442f076c81d272f24fc1bd71169327af015717d8`）保留原路径与原字节；保留旧包不表示可以直接覆盖降级。

[0.1.2 参考包](apk/MOTION-0.1.2-release.apk)继续保留原路径与原字节：versionCode **3**，**4,061,699 字节**，SHA256 `d4ed05a95ea2649066498b50aa6feafb3e69f58641f02d93f514c946dcb5d4a1`。保留旧包不表示可以直接覆盖降级。

## 2. 日常命令与输出

在 `app/` 内运行。依赖按提交的锁文件用 `npm ci` 安装；CI 约定 Node 24 / Java 21。真实 DOM 回归还需要可用的 Chrome；路径与证据目录通过脚本提供的环境变量配置。

| 命令 | 用途 |
|---|---|
| `npm ci` | 按锁文件重建依赖 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 全量单元测试（76 文件，1022 测试） |
| `npm run android:test:java` | 原生逻辑的纯 JVM 测试（22 个 Java 测试类）；不需要手机或 Android SDK |
| `npm run android:apk:release` | 完整 Android 打包：SDK 检查 → 类型检查 → 全量单测 → JVM 测试 → `dist-android` → `cap sync` → 静态门禁 → Gradle debug/release；签名目录由 `MOTION_SIGNING_DIR` 指定 |
| `npm run test:dom` | 真实 DOM 关键缺陷回归测试（10 套件 131 项） |
| `npm run test:b4r2` | Plans 导航与管理选择独立性真实 Chrome 检验（19 项） |
| `npm run check` | 统一完整检查（类型检查 + 单元测试 + JVM 测试 + DOM 回归 + Plans 导航） |
| `npm run build` | 常规 Web 构建与 Service Worker，输出 `dist-web/` |
| `npm run serve` | 默认服务 `dist-web/`；以终端打印的地址为准 |
| `npm run build:android` | Android 目标的 Web 资源，输出 `dist-android/`；不生成 APK |

常规 build、serve、preview 的默认目录保持一致。`MOTION_OUT_DIR` 可指定其他相对或绝对输出目录；Service Worker 必须写入同一构建目录。`MOTION_CHROME_PATH` 可覆盖 Chrome 执行路径，`MOTION_UI_EVIDENCE_DIR` 与 `MOTION_NATIVE_TEST_OUT` 可分别指定 UI 自动化与纯 JVM 测试的证据及编译临时输出目录，避免覆盖或污染历史构建与源码目录。

完整检查 `npm run check` 串联类型检查、全量单测、纯 JVM 测试、131 项 DOM 回归和 Plans 导航验证；具体入口以 `app/package.json` 与 CI 配置为准。JVM 测试证明纯 Java 逻辑，不能代替 Android Service、AlarmManager、通知渠道、锁屏或 OEM 的实际验证。

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

新包 versionCode 必须递增：当前为 **9**，下一候选至少为 **10**。Android 会限制低版本覆盖，不应直接用旧 APK 降级或通过卸载绕过。确需回退时先明确数据备份、恢复方案与安装身份，再执行经确认的操作。

新包使用新文件名，不能覆盖现有 0.1.8、0.1.7、0.1.2 或其他受保护材料。签名文件、密码、个人备份、缓存和浏览器 profile 不入版本库。

## 5. 真机结论与待验证范围

0.1.7 在同一荣耀手机上，用户将启动管理改为手动并确认三项开启后，短时无 USB 锁屏提醒复测通过；自动管理时曾失败。系统通知创建时间不等于用户听到或感到震动的延迟。

**0.1.8 尚未做任何真机验收**；0.1.7 的上述结论只属于 0.1.7 与该次条件，不能沿用到新包。

该结果仅适用于当次设备与设置。深 Doze、长时计时、进程被杀、其他 OEM、真实输入法以及不同文件提供器/真实数据规模下的导出恢复仍需要相应实测。单元、JVM、Chrome 或旧模拟器记录都不能扩大这些结论。

## 6. 保留与历史导航

- `app/src/`、`app/test/`、`app/android/`、`app/public/`、锁文件及模板文档是维护输入。
- 历史 `dist`、`dist-v2`…`dist-v8`、既有 APK、`_rollback/`、`_archive/` 和本机保留的验证材料不因本次文档整理而移动或删除。
- `_rollback/v2-snapshot-20261021b/src/` 是历史迁移测试依赖，须与测试一起保留，不能把所有 rollback 当作可清理缓存。
- [历史索引](docs/history/README.md)提供本次整理前的 README/MAINTENANCE 原文与 SHA256；其中各阶段状态、命令与机器路径只作为当时证据。迁移和恢复背景另见 [GITHUB-SYNC-FOLLOWUP.md](GITHUB-SYNC-FOLLOWUP.md)。
