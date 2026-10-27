# 2026-10-27：MOTION 0.1.7 私有仓库同步与卫生记录

## 已同步主体

主体提交 `71a6aa911b985cab14b0d8f91badf81f543a704c`（tree `c97ad0310e3de986ef13372bae3dcd3634e9165c`）已同步至私有仓库 `bluebirdflew4288-ui/motion-personal-training` 的 `main`。仓库仍为 **PRIVATE**；本次没有创建 Release、Tag 或 PR。提交包含已接受源码、回归测试、原生实现与测试、必要 fixtures/templates、维护配置和已验收 0.1.7 APK。0.1.7 是用户当前测试包，不代表公开发布。

Root 在 APFS 独立新克隆中验证：`npm ci --no-audit --no-fund`、`npm run typecheck`、Vitest 67 文件 / 955 项、原生 JVM 22 类及 4 个 UI 脚本 `node --check` 均退出 0；克隆工作树干净，typecheck 未在 `app/src` 生成 JavaScript。Root 从 GitHub 再次克隆，对 324 个主体提交文件逐字节核对通过；0.1.7 APK 为 4,122,041 字节，SHA256 `675bf332266671cf8a4c4821442f076c81d272f24fc1bd71169327af015717d8`。以上验证证据保存在 Codex Task `tasks/2026-10-27_motion-017-github-sync-hygiene/root-review/`。

## 本轮可恢复卫生处理

Root 已核准的 16 个本机 `.fix/.patch` 临时脚本逐项匹配 0.1.7 源清单 SHA256，并在主体源码、测试和构建入口中确认无引用。它们从 Android 插件源码目录移至本地归档 `_archive/maintenance-20261027/native-patch-scripts/`，保留原文件名和字节；映射、大小、SHA256 与恢复方法记录在该目录的 `RESTORE-MANIFEST.json`。对应 Codex Task 证据副本位于 `tasks/2026-10-27_motion-017-github-sync-hygiene/luna-audit/RESTORE-MANIFEST.json`。16 个路径旁均未发现 AppleDouble 伴生文件。该移动可按清单恢复；未删除脚本，未改 Java/TS 源码、测试、APK 或验收证据。

保护目录清点仍为 10,802 个文件 / 506,921,354 字节，Root 复核全部原字节未变；它是所选 APK、rollback/archive、verify 与历史 dist 目录快照，不代表全树且不含一般依赖。本轮归档前的实体清点为 20,067 个 AppleDouble/`.DS_Store` 项，计数覆盖依赖与旧 gitdir；本轮未清理。

## 本记录状态

本记录保存主体同步后的独立验收与可恢复卫生结果；文档修订及远端分支的最终状态以 Git 记录和实时核验为准。
