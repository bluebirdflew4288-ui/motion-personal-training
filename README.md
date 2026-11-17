# MOTION — 个人训练工作区

手机端、本地优先的个人训练记录应用，提供计划管理、逐组记录、组间休息计时、训练历史与统计，以及 JSON 备份恢复。应用源码在 `app/`。

## 当前状态

- 当前完整签名 release 包为 **0.1.14 / versionCode 15**（2026-11-18）：[MOTION-0.1.14-release.apk](apk/MOTION-0.1.14-release.apk)（4,187,477 字节，SHA256 `1d0a8e696f11924ea9ac358fbe578893324b114ef72f13a05e2b98b91e16aa1e`）。包含非输入区选区/菜单/原生拖拽三层防护（全局非编辑区 `user-select:none` 与收起态操作层隐藏、`MotionWebView` 原生长按/`ActionMode`/`dispatchDragEvent` 非输入区门禁）以及卡片手势协调器与状态机收敛优化；电脑阶段全套回归、完整构建及实际 APK 版本/同证书 v2/v3 签名/16KB zipalign/编译布局 `MotionWebView`/资源校验通过。包名 `app.motion.personal`，原生 origin `https://localhost`，签名证书 SHA256 `d423bf800e7c275c5cd3c556912a7d64f08f78569675072de84925659fe964bb`。**用户已在荣耀真机安装确认长按拖动调整位置正常**；未公开发布（中间候选包 0.1.9–0.1.13 保留在本机磁盘供回滚，不重复入库）。
- 上一完整签名 release 候选包为 **0.1.13 / versionCode 14**（2026-11-17）：[MOTION-0.1.13-release.apk](apk/MOTION-0.1.13-release.apk)（4,184,602 字节，SHA256 `c83544e426fa8aa12ebd5ed0c2f998a9ba62f98d8e4ef091f0ac8e386954d27f`）保留原路径与原字节；包含重量填写简化、编辑替换动作自动带入上次保存的配置，以及多触点取消待长按/拖动的修复；电脑阶段验收与验包通过，荣耀真机反馈单指长按仍触发系统选词提示窗及二次按压唤出任意门，已由 0.1.14 针对性返修。
- 上一完整签名 release 候选包为 **0.1.12 / versionCode 13**（2026-11-16）：[MOTION-0.1.12-release.apk](apk/MOTION-0.1.12-release.apk)（4,182,214 字节，SHA256 `18c14a0feeefd3aae88f929df2e5cd0e61c2fff8b10efc1dc5b520d13dc054a4`）保留原路径与原字节；本轮逐轮配置、沿用身份、删轮清理、行内提示、容量门禁与提示条交互已通过电脑独立验收，完整构建及实际 APK 验签/资源校验通过，**待真机验收**，未安装手机、未公开发布。
- 上一版本 **0.1.11 / versionCode 12**：[MOTION-0.1.11-release.apk](apk/MOTION-0.1.11-release.apk)（4,173,989 字节，SHA256 `242dde8f802e97f4db4880f2484883e86e03872123943b8c5c3114833bbd1d24`）保留原路径与原字节；该包的真机验收未完成。
- 0.1.10 / versionCode 11（[MOTION-0.1.10-release.apk](apk/MOTION-0.1.10-release.apk)，4,173,693 字节，SHA256 `6dbabeae09581c76a1b417940f5fd9a2acbe6b64b543050f7436e488e4125eba`）**已被用户真机拒收**：折叠卡长按出现 Android 原生文本选择菜单与选择手柄，左滑删除与 F09 释放删除横幅为橙色而非要求红色；不作为验收通过。0.1.11 为 G01/G02 返工候选，仍待真机验收。
- 更早 **0.1.9 / versionCode 10** 保留原路径与原字节：[MOTION-0.1.9-release.apk](apk/MOTION-0.1.9-release.apk)（4,138,326 字节，SHA256 `59c4a39a874943d4f5b1ff5598d2385e9630ae486eed61630d176f37e4678b31`）。
- 更早 **0.1.8 / versionCode 9** 保留原路径与原字节：[MOTION-0.1.8-release.apk](apk/MOTION-0.1.8-release.apk)（4,124,667 字节，SHA256 `4222f91e5b2cc8adbba6b4fa9bee85c565f075974d917ce9680acf03e1c2b90d`）。保留旧包不表示可以直接覆盖降级。
- 同一荣耀手机在手动启动管理、用户确认三项开启的条件下，0.1.7 的短时无 USB 锁屏提醒复测通过。该结论仅限本机和当次条件，不能沿用到 0.1.9；深 Doze、长时计时、进程被杀及其他 OEM 仍未验证。
- CI 配置与源码检查结果须分别看待：目前没有远端 CI 已通过的结论，也没有新版本发布。

继续维护、版本身份与升级保护见 [MAINTENANCE.md](MAINTENANCE.md)；原始版本记录见 [历史索引](docs/history/README.md)。

## 本地运行

在仓库根目录执行：

```sh
cd app
npm ci
npm run build
npm run serve
```

常规 Web 构建、服务与预览统一使用 `app/dist-web/`。打开终端打印的地址；手机局域网访问需与电脑处于同一网络。停止服务时，在启动它的终端按 `Ctrl+C`。历史 `dist`、`dist-v2`…`dist-v8` 保留，不作为当前默认输出。

局域网 HTTP 不具备 Service Worker 所需的安全上下文，不能据此声称手机已可离线启动。Android 包自带本地资源，原生目标不注册 Service Worker。

## 数据与备份

训练数据保存在当前设备的 IndexedDB；仓库源码、APK 和构建快照都不包含个人训练数据库。更新、换机、卸载或清理应用数据前，请在应用内「设置 → 导出 JSON 备份」，并妥善保留导出文件。

完整备份恢复会覆盖当前计划、训练记录与相关设置，不做合并。导入前先查看预览；计划模板导入是另一种格式，使用 [模板说明](docs/templates/plan-template-v1.md)。

浏览器的协议、域名和端口共同决定数据空间；更换地址可能看到一份空数据。Android 覆盖升级须保持包名、签名和原生 origin，**不要卸载后重装来代替升级**。更多边界见维护入口。
