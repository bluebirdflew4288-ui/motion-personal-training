# MOTION — 个人训练工作区

手机端、本地优先的个人训练记录应用，提供计划管理、逐组记录、组间休息计时、训练历史与统计，以及 JSON 备份恢复。应用源码在 `app/`。

## 当前状态

- 当前本地测试候选包为 **0.1.8 / versionCode 9**：[MOTION-0.1.8-release.apk](apk/MOTION-0.1.8-release.apk)（4,124,667 字节，SHA256 `4222f91e5b2cc8adbba6b4fa9bee85c565f075974d917ce9680acf03e1c2b90d`）。包名 `app.motion.personal`，原生 origin `https://localhost`，签名证书 SHA256 `d423bf800e7c275c5cd3c556912a7d64f08f78569675072de84925659fe964bb`。
- 0.1.8 是本轮源码修复（计划名称边界、Esc 取消输入、历史纠错离页保护、计时恢复操作、首次播种和预览服务异常处理）首次构建出的可安装包；**尚未经过真机验收**，也未公开发布。
- 上一版 **0.1.7 / versionCode 8** 保留原路径与原字节：[MOTION-0.1.7-release.apk](apk/MOTION-0.1.7-release.apk)。保留旧包不表示可以直接覆盖降级。
- 同一荣耀手机在手动启动管理、用户确认三项开启的条件下，0.1.7 的短时无 USB 锁屏提醒复测通过。该结论仅限本机和当次条件，不能沿用到 0.1.8；深 Doze、长时计时、进程被杀及其他 OEM 仍未验证。
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
