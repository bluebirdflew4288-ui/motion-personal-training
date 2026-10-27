# 2026-10-27：0.1.7 当前测试包同步准备

## 范围与状态

本次准备把已接受的 MOTION 源码、回归测试、必要模板/fixture、维护文档及 0.1.7 APK 同步到私有 GitHub 仓库 `bluebirdflew4288-ui/motion-personal-training` 的 `main`。这是本地仓库准备记录；**当前尚未提交或推送**。Root 将先检查暂存区，再在 APFS 独立克隆中安装依赖并运行类型检查、955 项回归与 22 类原生 JVM 检查。这里不预写这些后续检查的结果。

审计时本地 `master` 跟踪 `origin/main`，两者均指向 `46f42d5d2879bf76640fe7b99cf7807e16b42604`。0.1.7 APK 是用户当前测试包，不代表公开发布：4,122,041 字节，SHA256 `675bf332266671cf8a4c4821442f076c81d272f24fc1bd71169327af015717d8`。其设备测试结论仅适用于本次荣耀手机手动启动管理条件下的短时复测；深 Doze、长时计时、进程被杀和其他 OEM 仍未验证。0.1.2 APK 保留为既有参考资产。

## 本次拟纳入版本库

- 已接受的正式 `app/src`、`app/test`、Android 原生插件与原生测试，以及必要配置和通用 `test-native.mjs` 入口。
- 两份合成/模板 fixture 与 `docs/templates/` 中的格式文档、示例。
- 四个 UI 施工者自查脚本。只为 Chrome 可执行文件和手机测试证据目录增加环境变量覆盖；默认场景、断言、数据读写行为不变。这些脚本依赖本机 Chrome 和 `puppeteer-core`，属于自查工具，不作为独立验收证据。
- README、MAINTENANCE、CLEANUP、忽略规则及本同步说明。
- 已验收的 `apk/MOTION-0.1.7-release.apk`。既有 tracked `apk/MOTION-0.1.2-release.apk` 保持原字节。
- `_rollback/v2-snapshot-20261021b/src/` 已跟踪内容继续保留，因为既有迁移测试会动态导入它。

Android `assets/public` 和 Capacitor 生成文件遵循既有忽略规则留在本机，不强制入库。

## 本机保护范围

0.1.3–0.1.6 失败/中间 APK、其余 rollback 与 dist、verify/evidence/profile、Agent Task 材料、签名秘密、机器配置和 AppleDouble 元数据均保留原位，不纳入此次同步。`.gitignore` 采用逐路径规则，不使用全局 `*.apk`，不忽略 0.1.7。此次没有物理清理、删除或搬移项目资产。Root 对指定保护目录（APK、rollback/archive、各 verify 与历史 dist）的快照清单有 10,802 个实文件、506,921,354 字节；这是所选保护目录而非全树统计，不含一般依赖目录。整个 Project 的物理元数据计数为 20,067 个 AppleDouble/`.DS_Store` 文件，范围包含依赖与旧 gitdir；未清扫，也不以零计数描述本机状态。

## 验收闸门

暂存只按批准清单逐路径执行，禁止 `git add .`。Root 独立审查 staged 文件、内容敏感性、0.1.7 APK 哈希和新克隆可复现性。通过后再由 Root 明确授权提交及正常推送；此记录不表示 GitHub 已更新。
