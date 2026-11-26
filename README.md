# MOTION

**个人训练记录与 AI 教练应用 · Local-first training workspace**

从训练计划、逐组记录到训练历史与进步分析，将日常健身流程集中到一个手机端工作区。以本地数据为核心，兼顾 Web 与 Android 使用场景。

`React 19` · `TypeScript` · `Vite` · `Capacitor 8` · `IndexedDB`

[下载已验收 Android APK（v0.2.0）](apk/MOTION-0.2.0-release.apk) · [本地运行](#本地运行) · [维护文档](MAINTENANCE.md)

## 核心功能

| 模块 | 功能 |
| --- | --- |
| 训练计划 | 周期计划、动作与训练日管理、共享计划模板 |
| 训练执行 | 逐组记录、组间休息计时、器械档位备忘、有氧记录 |
| 训练复盘 | 训练历史、月历、趋势统计、PR 印章、训练小票 PNG 导出 |
| 数据管理 | IndexedDB 本地存储、JSON 备份与恢复、历史数据格式兼容 |
| AI 教练（开发中） | 模型协议适配、确定性事务处理、前缀缓存与调用计费记录 |

## 工程实践

- **本地优先：** 训练数据存储于设备，核心训练记录不依赖远程数据库；Web 与 Android 分别构建。
- **AI 应用集成：** v0.2.3 源码包含三协议模型适配、事务幂等、三层前缀缓存及计费账单逻辑；真实模型调用与计费仍待验证。
- **质量与交付：** TypeScript 类型检查、Vitest 单元测试、浏览器 DOM 回归、纯 JVM 原生逻辑测试、Android 构建与签名验证。
- **数据兼容：** 已验收 v0.2.0 支持 v4 完整备份，并可恢复合法的 v1–v3 备份；计划模板与完整备份采用独立格式。

## 版本与验证状态

截至 2026-11-26 的仓库记录：

| 版本 | 状态 | 验证记录 |
| --- | --- | --- |
| v0.2.3 / 24 | 当前开发源码 | 1,462 项单元测试、纯 JVM 测试及本地签名包通过；真机与真实计费待验证 |
| v0.2.0 / 21 | 已人工验收的签名 APK | 浏览器验证 9 项、正式 APK 验包 25 项通过 |
| v0.1.19 / 20 | 常用回滚包 | Chrome 端到端验证 12 项、正式 APK 检查 24 项通过 |

以上为项目已有验证记录，并非本次文档更新重新运行的测试。仓库已配置 GitHub Actions，但尚无远端 CI 通过结论。v0.2.3 不作为已正式发布或真机验收的版本。

- [v0.2.0 APK](apk/MOTION-0.2.0-release.apk)
- [v0.1.19 APK](apk/MOTION-0.1.19-release.apk)（历史回滚用途，不建议直接降级）

## 本地运行

需要 Node.js >= 22.12.0。

```bash
cd app
npm ci
npm run build
npm run serve
```

打开终端显示的地址。Web 构建默认输出到 `app/dist-web/`。手机可在同一局域网访问，但普通局域网 HTTP 不具备 Service Worker 所需的安全上下文；Android 包内置本地资源。

### 开发与测试

```bash
npm run dev
npm run typecheck
npm test
npm run android:test:java
```

完整检查使用 `npm run check`；浏览器回归需要 Chrome，Android 打包另需相应 SDK、Java 环境及签名配置。详见 [维护文档](MAINTENANCE.md)。

## 数据与升级安全

训练数据保存在当前设备的 IndexedDB，不随源码、APK 或构建快照备份。

更新、换机或清理数据前，请在应用内「设置 → 导出 JSON 备份」。完整备份恢复会覆盖当前数据，不做合并。Web 地址变更可能切换数据空间；Android 覆盖升级须保持包名、签名及原生 origin 一致。**不要通过卸载后重装来代替升级。**

## 项目导航

| 路径 | 内容 |
| --- | --- |
| [app/](app/) | 应用源码、构建配置、测试与 Android 工程 |
| [apk/](apk/) | 已保留的签名安装包 |
| [MAINTENANCE.md](MAINTENANCE.md) | 构建、校验值、维护及升级保护 |
| [模板说明](docs/templates/plan-template-v1.md) | 计划模板格式与兼容说明 |
| [历史索引](docs/history/README.md) | 历史版本与原始工程记录 |
| [本次改版前的 README](https://github.com/bluebirdflew4288-ui/motion-personal-training/blob/0cc7e012704d590243349e2e5d3c83e6d9caee97/README.md) | 完整历史状态、版本细节与验证边界 |

个人项目，持续开发中。仓库公开用于项目展示与技术交流；公开可见不代表已授予开源许可。
