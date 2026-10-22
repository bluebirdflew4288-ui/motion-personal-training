# MOTION → GitHub 私有仓库同步记录

时间：2026-10-22 19:40 CST
状态：**已提交并推送，验证通过。** 本文件不含任何秘密或个人数据。

---

## 1. 仓库

| 项 | 值 |
|---|---|
| URL | https://github.com/bluebirdflew4288-ui/motion-personal-training |
| owner | `bluebirdflew4288-ui` |
| 可见性 | **PRIVATE**（API `private: true`，`visibility: private`，推送前后各核验一次） |
| 默认分支 | `main` |
| 本次推送分支 | `main` |

> 未创建 Pages、未部署、未创建公网服务、未改动任何其他仓库、未付费。

---

## 2. 提交与远端一致性

| 项 | 值 |
|---|---|
| 本地 HEAD | `b4e39a562191194b1e9f93b2c9377559889cabde` |
| 远端 `main` | `b4e39a562191194b1e9f93b2c9377559889cabde` |
| 一致性 | ✔ 一致（`git ls-remote` + GitHub API 双验） |
| 提交数 | 3 |
| 入库文件数 | 225 |

提交历史：
```
b4e39a5  移除误入库的施工期临时补丁脚本（16 个）
5e8c0c8  修复 gradlew 可执行位（exFAT 不保存 Unix 权限位）
f0747e7  MOTION 0.1.2：源码、测试与已验收 APK 首次入库
```

---

## 3. Git 元数据位置（已于 2026-10-22 迁移至内置 APFS）

### 当前状态（迁移后，生效中）
```
工作树：/Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app
活动 gitdir：/Users/linyu/.local/share/agent-project-git/motion-personal-training.git   ← 内置 APFS
.git ：指针文件，内容为上面这行 gitdir
```

- `core.worktree` 指向原工作树，`core.filemode=false`（exFAT 不保留执行位），
  `app/android/gradlew` 索引 mode 显式标记 `100755`。
- 活动 gitdir **无 AppleDouble**（迁移时已过滤）。
- 提交身份为**仓库级**配置（未改全局）：`bluebirdflew4288-ui` + GitHub noreply 邮箱。

### 历史（迁移前）
初次同步时 `~/.local/share` 处于沙箱外不可写，gitdir 只能落在项目内
`<项目根>/.git-motion`（exFAT）。该状态**不满足迁移约束**（非「理想方案未实现」，
而是明确约束未满足），因此本轮在获得合法写入权限后完成迁移。

### 回滚来源（保留，不删除）
```
_archive/gitdir-migration-20261022/
  dot-git-pointer.bak                    旧 .git 指针原件（133 B）
  git-motion-full-863.tar.gz             完整归档：863 文件（含 527 AppleDouble）
  git-motion-full-863.tar.gz.sha256      归档 SHA256
  git-motion-full-863-manifest.txt       逐成员 size/sha256/path 清单
  protected-baseline-before.txt          迁移前 240 行保护基线
  dist-rollback-hashes.txt               dist/rollback 哈希
  git-motion/                            ⚠ 仅 336 真实 Git 文件的副本，
                                         缺 527 个 AppleDouble，**不适合作回滚**
                                         （目录内有 INVALID-DO-NOT-USE-FOR-ROLLBACK.txt 标记）
  git-motion-member-manifest.txt         迁移前 .git-motion 成员清单
  git-motion-dirs.txt                    迁移前目录结构
  APFS-PERMISSION-BLOCKER.md             迁移前的权限阻碍记录（历史）
```
旧 `<项目根>/.git-motion/` **仍完整保留在原位**（863 文件未变），作为回滚来源，已加入 `.gitignore`。

### 迁移步骤摘要（已完成）
1. 记录保护基线（源码/测试/配置/脚本/public/APK/dist/rollback 哈希）
2. 备份旧 `.git` 指针与整个 `.git-motion`（Python tarfile 手工逐成员，863/863 校验通过）
3. 在 APFS 建 bare 副本（`git clone --no-hardlinks`）
4. 补齐 `refs/remotes/origin/main`、复制 `config` 与 `index`、设置 `core.worktree`
5. 过滤副本 AppleDouble → `fsck --full --strict` 健康
6. 演练只读连接原工作树：HEAD/branch 一致、工作树干净、`gradlew` 100755
7. 原子切换 `.git` 指针（写临时文件后 `mv`）
8. 切换后验证：`rev-parse --absolute-git-dir`、`fsck`、refs 与切换前逐条一致、
   `status` 干净、活动 gitdir 无 AppleDouble

> 未使用 `git clean` / `git reset` / `force push`，未重写历史。

---

## 4. 入库内容（225 文件 / 约 6.5 MB）

| 类别 | 说明 |
|---|---|
| 生产前端源码 | `app/src/`（59 文件） |
| 正式测试 | `app/test/`（33 文件，含 `fixtures-v1-backup.json`） |
| 原生 Android | `app/android/app/src/`、Gradle wrapper 与必要配置（70 文件） |
| public 素材 | `app/public/` 字体/图片/图标（23 文件） |
| 构建/验证脚本 | `app/scripts/`（6 文件） |
| 配置 | `package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`vitest.config.ts`、`capacitor.config.ts`、`index.html` |
| 维护文档 | `README.md`、`MAINTENANCE.md`、`CLEANUP.md`、`.gitignore` |
| **已验收 APK** | `apk/MOTION-0.1.2-release.apk` |
| **历史测试 fixture** | `_rollback/v2-snapshot-20261021b/src/`（38 文件） |

### APK 指纹
```
apk/MOTION-0.1.2-release.apk
size   : 4061699
SHA256 : d4ed05a95ea2649066498b50aa6feafb3e69f58641f02d93f514c946dcb5d4a1
```
未重新构建、未替换该包。

### 为什么必须带 `_rollback/v2-snapshot-20261021b/src`
`app/test/v4-backup.test.ts` 与 `app/test/v5-migrate-delete.test.ts` 在运行时**动态 import**
`../../_rollback/v2-snapshot-20261021b/src/domain/`，用真实历史构造器生成 fixture。
不提交这棵子树，克隆后这两条测试会直接断链。
`.gitignore` 用精确白名单只放行该子树，其它回滚快照仍整体忽略。

---

## 5. 保留在本机、未入库

| 类别 | 位置 |
|---|---|
| `node_modules`、构建缓存、`.gradle`、`native-test/out` | `app/` |
| 历史 Web 构建 | `app/dist`、`app/dist-v2`…`dist-v8`、`app/dist-android`、`app/dist-baseline-011` |
| 其它回滚快照 | `_rollback/`（除 v2 的 src 子树） |
| 验收报告/截图/JSON | `verify/`、`verify-v4`…`verify-v8`、`verify-android*`、`verify-plan-011`、`verify-zero-byte/` |
| 本地归档 | `_archive/maintenance-20261022/` |
| 历史旧包 | `apk/MOTION-0.1.0-*.apk`、`apk/MOTION-0.1.1-release.apk` |
| 历史报告 | `返工报告*.md`、`Android交付报告.md`、`HANDOFF-*.md`、`手机复测清单*.md` |
| 本地服务信息 | `LAN-INFO*.txt` |
| 机器配置 | `app/android/local.properties`（含本机 SDK 路径） |
| 签名材料 | `~/.motion-android-signing/`（项目外，**从未入库**） |

> 被忽略的本地文件**全部保留在原位**，未删除。

---

## 6. 敏感内容扫描结论

| 检查项 | 结果 |
|---|---|
| 私钥/证书（`*.jks`/`*.keystore`/`keystore.properties`/`*.pem`/`*.key`） | ✔ 无 |
| Token/凭据（`ghp_*`/`gho_*`/`sk-*`/`AKIA*`/`BEGIN PRIVATE KEY`） | ✔ 无 |
| `.env` / `credentials.json` / 会话内容 | ✔ 无 |
| `local.properties`（机器路径） | ✔ 已排除 |
| AppleDouble `._*` / `.DS_Store` | ✔ 无（首次提交曾误入 45 个，已从索引清除） |
| `node_modules` / `build` / `dist` / `.gradle` | ✔ 无 |
| 真实个人数据（姓名/电话/身份证/邮箱） | ✔ 无 |

### 关于 PII 扫描的 3 处命中（已逐一排除）
扫描曾对 `README.md`、`app/test/fixtures-v1-backup.json`、`app/test/v012-export-spool.test.ts`
报出「疑似 11 位数字」。逐一核实后**全部是 epoch 毫秒时间戳**
（如 `17925052721` 是 `exportedAt` 字段的一部分），不是手机号。
邮箱模式命中数为 0。

### 测试数据性质
- `app/test/fixtures-v1-backup.json`：2026-10-20 开发期自造测试数据，
  session id 为 `sess-mvguai2i-*`，内容为「三分化训练计划 V3.2 / 胸 B」，无个人标识。
- 所有 `verify-zero-byte/fixture-*.json` 为合成数据（`sess-fx-*` / `sess-cn-*`），**未入库**。
- **本轮没有读取、也没有上传任何用户真实手机数据库。**

---

## 7. 隔离克隆验证（全新克隆，非原工作树）

临时克隆目录：`/tmp/motion-final-verify-1792669123`（验证后已清理）

| 检查 | 结果 |
|---|---|
| 克隆 HEAD | `b4e39a562191194b1e9f93b2c9377559889cabde`（与远端一致） |
| 文件数 | 225 |
| `gradlew` 权限 | `-rwxr-xr-x`（可执行） |
| 临时补丁脚本残留 | 0 |
| `npm ci`（锁定依赖） | ✔ 成功，290 包 |
| `npx tsc --noEmit` | ✔ **exit 0** |
| `npx vitest run` | ✔ **32 文件 / 422 测试全部通过** |
| 历史 fixture 链（`v4-backup` + `v5-migrate-delete`） | ✔ **30/30 通过**，fixture 真实加载（非跳过） |
| 原生构建路径 | ✔ `build.gradle`、`settings.gradle`、`gradle-wrapper.properties`、`AndroidManifest.xml`、三个插件源码、`capacitor.config.ts` 均在位 |
| 签名材料 | ✔ 克隆中不存在（正确） |
| `local.properties` | ✔ 克隆中不存在（正确） |

---

## 8. 维护入口

- **继续维护请读** [`MAINTENANCE.md`](./MAINTENANCE.md)
- 构建命令、APFS 构建落点、发新版完整顺序（备份→构建→复制）、
  三项保持一致（包名/证书/origin）、回滚路径都在那里。
- **签名材料如何指向本机现有目录**：仓库内不含任何密钥。
  在本机设置环境变量 `MOTION_SIGNING_DIR=/Users/<你>/.motion-android-signing`，
  或保持默认路径 `~/.motion-android-signing/`（含 `keystore.properties` + `motion-release.jks`）。
  Gradle 在找不到该目录时会让 release 保持未签名（不会失败），**密钥绝不上传**。

---

## 9. 未完成 / 边界

| 项 | 状态 |
|---|---|
| gitdir 放在内置 APFS | **未达成**。`~/.local/share` 在沙箱外不可写，实际放在项目内 `.git-motion`（exFAT）。如需迁移，可在有权限时用 `git init --separate-git-dir` 重建。 |
| 真机验收 | 未做。0.1.2 仅模拟器实证，需用户在自己手机覆盖安装后长期反馈。 |
| 历史旧包 / dist / verify 入库 | 按指令**不入库**，本机保留。 |
| 临时验证目录 | `/tmp/motion-clone-verify-*`、`/tmp/motion-final-verify-*` 已清理。 |

---

## 10. 本次未做的事

未重新构建 APK、未重新签名、未操作手机、未改测试断言、
未 `git clean`/`reset`/`force push`、未改全局 Git 配置、
未创建 Pages/部署/公网服务、未上传 Workspace 整体、未上传共享治理仓库、
未上传 Codex 私有审查目录、未提交/推送其他项目。
