# MOTION Git 元数据迁移 + 原生测试补齐（收尾报告）

时间：2026-10-22 20:30 CST
状态：**已完成并推送，验证通过。** 本文件不含任何凭据或个人数据。

---

## 1. 新提交

| 项 | 值 |
|---|---|
| commit | `e6d12ca2ccd6aa50c22474d860b6e39bfd73bd73` |
| 分支 | `master`（本地）→ 推送至远端 `main` |
| 远端 main | `e6d12ca2ccd6aa50c22474d860b6e39bfd73bd73`（`ls-remote` + API 双验一致） |
| 仓库 | https://github.com/bluebirdflew4288-ui/motion-personal-training |
| 可见性 | **PRIVATE**（`private: true`，推送前后各核验） |
| 入库文件 | 230（新增 4 个测试 + 2 个文档更新） |

提交历史（5 个，既有 4 个提交全部保留，未重写历史）：
```
e6d12ca  补齐 4 个原生 JVM 测试并迁移 Git 元数据至内置 APFS
65c16f0  新增 GITHUB-SYNC.md：私有仓库同步与验证记录
b4e39a5  移除误入库的施工期临时补丁脚本（16 个）
5e8c0c8  修复 gradlew 可执行位（exFAT 不保存 Unix 权限位）
f0747e7  MOTION 0.1.2：源码、测试与已验收 APK 首次入库
```

---

## 2. Git 元数据迁移（S02）

### 迁移前状态
```
gitdir: <项目根>/.git-motion      ← exFAT，863 文件（含 527 个 AppleDouble）
.git  : 指向上述路径的指针文件
HEAD  : 65c16f0（branch master，跟踪 origin/main）
```
> 说明：此前记录为「沙箱不可写，故采用项目内方案」，实际性质是
> **明确的迁移约束未满足**（不是「理想方案未实现」）。本轮已纠正并完成。

### 迁移后状态（生效中）
```
工作树    : /Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app
活动 gitdir: /Users/linyu/.local/share/agent-project-git/motion-personal-training.git   ← 内置 APFS
.git      : 指针文件（内容为上面一行）
```

关键配置：
- `core.worktree` → 原工作树
- `core.filemode = false`（exFAT 不保留执行位）
- `app/android/gradlew` 索引 mode = **100755**（显式标记）
- 活动 gitdir **AppleDouble = 0**

### 迁移步骤（全部完成）
1. 记录保护基线（源码/测试/原生 Java/配置/脚本/public/APK/dist/rollback）
2. 备份旧 `.git` 指针（`dot-git-pointer.bak`）与整个 `.git-motion`
3. APFS 建 bare 副本（`git clone --no-hardlinks`）
4. 补齐 `refs/remotes/origin/main`、复制 `config` 与 `index`（226 条目）
5. 过滤副本 AppleDouble（489 个）→ `fsck --full --strict` 健康
6. 演练只读连接原工作树：HEAD/branch 一致、已跟踪修改 0、gradlew 100755
7. **原子切换** `.git` 指针（写 `.git.new` 后 `mv`）
8. 切换后验证（见下）

### 切换后验证
| 检查 | 结果 |
|---|---|
| `rev-parse --absolute-git-dir` | APFS 路径 ✔ |
| `git fsck --full --strict` | 健康（仅历史悬空 blob，正常） |
| refs 与切换前逐条对比 | **完全一致**（2 refs） |
| `git status` | 已跟踪修改 **0**；未跟踪 30（本机保留文件） |
| 活动 gitdir AppleDouble | **0** |
| `gradlew` 索引 | `100755` ✔ |

> 未使用 `git reset` / `git clean` / `force push`，未重写历史。

---

## 3. 备份与回滚（保留，未删除原件）

### 完整备份（唯一合格的保真归档）
```
_archive/gitdir-migration-20261022/git-motion-full-863.tar.gz
  size   : 5308151 bytes
  SHA256 : 763dcf7b5b65f6c84b8ccdecd2ff491b49db9f7f4a682a06f3bf23255fe839ce
  成员   : 863 文件（含 527 个 AppleDouble）
  生成方式: Python tarfile 手工 TarInfo/addfile 逐成员写入
            （不复制 xattr、不调用系统 tar、不经 macOS 元数据过滤）
  校验   : 读回归档逐个匹配 名称 / 长度 / SHA256 → 863/863 全部一致，
           零缺失、零多余
  清单   : git-motion-full-863-manifest.txt（逐成员 size/sha256/path）
```

### 其它备份材料
```
_archive/gitdir-migration-20261022/
  dot-git-pointer.bak                 旧 .git 指针原件（133 B）
  git-motion-full-863.tar.gz.sha256   归档哈希
  git-motion-full-863-manifest.txt    完整成员清单
  protected-baseline-before.txt       迁移前 240 行保护基线
  dist-rollback-hashes.txt            dist/rollback 哈希
  git-motion-member-manifest.txt      迁移前成员清单（866 条）
  git-motion-dirs.txt                 迁移前目录结构（192 目录）
  APFS-PERMISSION-BLOCKER.md          迁移前权限阻碍记录（历史，已解除）
  git-motion/                         ⚠ 不合格副本（见下）
```

### ⚠ 明确标记的不合格副本（按实际数量记录）
`_archive/gitdir-migration-20261022/git-motion/` 当前 **862 个文件**
（525 个 AppleDouble + 337 个真实 Git 文件），与原件 863 相比
**只缺 3 个成员**：

```
objects/._info
objects/._pack
refs/._tags
```

另多出 2 个是本轮放置的标记文件（`INVALID-DO-NOT-USE-FOR-ROLLBACK.txt` 及其 AppleDouble）。

**结论**：虽然只缺 3 个成员，但既然要求是「原件完整保真」，
这份副本仍**不满足该要求，不可作为回滚依据**。
唯一合格的完整备份是 `git-motion-full-863.tar.gz`（863/863 逐字节校验通过）。

### 旧原件（回滚来源，完整保留）
```
<项目根>/.git-motion/     863 文件（含 527 AppleDouble），未改动、未删除
```
已加入 `.gitignore`，作为回滚来源长期保留。

### 恢复方法（如需，**不要把活动元数据退回 exFAT**）

> ⚠️ **不要**直接 `cp dot-git-pointer.bak .git` 回切。
> 原因有两条：
> 1. 旧 gitdir 在 exFAT 上、带 527 个 AppleDouble，不符合迁移约束；
> 2. 旧指针指向的 HEAD 是 `65c16f0`（迁移前时点），**不含本轮后续提交**
>    （`e6d12ca` 原生测试、`825624a` 收尾报告、`621bb25` 忽略规则）。
> 回切会丢掉这些提交并退回不合规的元数据位置。
>
> 旧指针 `dot-git-pointer.bak` 与旧 `.git-motion/` 的定位是
> **取证与恢复源**，不是可执行的回滚开关。

**正确的恢复流程（全程只在 APFS 上建新活动 gitdir）：**

1. **先保存当前状态**（在任何操作之前）
   ```bash
   cd "<项目根>"
   git rev-parse HEAD
   git for-each-ref --format='%(refname) %(objectname)' > /tmp/refs-current.txt
   git status --porcelain > /tmp/worktree-current.txt   # 含未推送改动
   ```
2. **把已验证归档解到新的 APFS 隔离目录**（不要解到项目内、不要覆盖现有）
   ```bash
   RESTORE="/Users/linyu/.local/share/agent-project-git/_restore-check-$(date +%Y%m%d-%H%M%S)"
   [ -e "$RESTORE" ] && { echo "已存在，拒绝覆盖"; exit 1; }
   mkdir -p "$RESTORE"
   python3 - "$RESTORE" <<'PY'
   import sys, tarfile
   dest = sys.argv[1]
   with tarfile.open("_archive/gitdir-migration-20261022/git-motion-full-863.tar.gz", "r:gz") as t:
       t.extractall(dest)   # 解出后再在副本里过滤 metadata
   PY
   ```
3. **在副本内过滤 AppleDouble、跑 fsck、核对历史**
   ```bash
   find "$RESTORE" -type f -name '._*' -delete
   git --git-dir="$RESTORE/.git-motion" fsck --full --strict
   git --git-dir="$RESTORE/.git-motion" log --oneline | head
   ```
4. **从健康远端与保留的本地 refs 补全后续提交**，并证明无丢失
   ```bash
   git --git-dir="$RESTORE/.git-motion" fetch origin
   # 比对：远端 main、本地 master、/tmp/refs-current.txt 三者关系
   ```
5. **只有确认无丢失后**，才原子指向另一个**干净的 APFS** gitdir
   ```bash
   printf 'gitdir: %s\n' "<新的 APFS gitdir>" > .git.new && mv .git.new .git
   git rev-parse --absolute-git-dir && git fsck --full --strict && git status
   ```

**约束**：任何情况下都不把活动 Git 元数据退回 exFAT；旧 `.git-motion/` 与
`dot-git-pointer.bak` 仅作取证与恢复源保留，不删除。

---

## 4. 补齐的原生测试（S01）

远端此前完全没有这 4 个正式原生测试，本轮按原样纳入（**未修改任何测试内容**）：

| 文件 | SHA256 | 项数 |
|---|---|---|
| `app/android/native-test/BackupIoTest.java` | `3da54ebbf2056a136a6c76594292b8fabc5e5db72c4bfb9836d65c1bcd0b7e09` | 24 |
| `app/android/native-test/ExportSpoolTest.java` | `fcfe51df2b6122241d6c85b96f1802f6922c9c9c231ff1daa5e45b67a30f8915` | 58 |
| `app/android/native-test/ExportPhaseTest.java` | `6a37cceedfc59240b00637333995aa6f8afcae6849457aa24b6d1d71cb83629b` | 13 |
| `app/android/native-test/ExportOriginalBindingTest.java` | `184cabb7dbd7822093a2086d046c719a22075f4bd285fcd59c2264c50997c083` | 12 |
| **合计** | | **107** |

- 4 个文件哈希与给定值**逐一匹配**
- `out/` 编译产物**未入库**（已被 `app/android/.gitignore` 的 `out/` 规则排除）

---

## 5. 隔离克隆验证（全新 APFS 克隆）

临时克隆：`/Users/linyu/.local/share/agent-project-git/_verify-clone-1792672053`（验证后已清理）

| 检查 | 结果 |
|---|---|
| 克隆 HEAD | `e6d12ca`（与远端一致） |
| 文件数 | 230 |
| **4 个 Java 测试** | ✔ 原样存在，SHA256 全部匹配 |
| `out/` 目录 | ✔ 0（未入库） |
| 签名文件（`*.jks`/`*.keystore`/`keystore.properties`） | ✔ 0 |
| `local.properties` | ✔ 0 |
| `npm ci` | ✔ 290 包 |
| **`node scripts/test-native.mjs`** | ✔ **107 项全部通过**<br>BackupIo 24 / ExportSpool 58 / ExportPhase 13 / ExportOriginalBinding 12 |

> 422 项 Vitest 已由 Codex 独立通过，本轮只加测试与文档、无生产代码变化，
> 故未重复全跑（按指令）。

---

## 6. 保护哈希证明（迁移 + 提交全程未变）

基线 240 行（源码/测试/原生 Java/配置/脚本/public）+ APK，迁移前后逐字节一致：

| 类别 | 结果 |
|---|---|
| APK ×4 | ✔ 未变 |
| `app/src` + `app/test` + `app/android/app/src` | ✔ 未变 |
| 配置（package.json/lock、tsconfig、vite、vitest、capacitor、build.gradle 等） | ✔ 未变 |
| `app/scripts/*.mjs` | ✔ 未变 |
| `app/public` | ✔ 未变 |
| dist ×10 目录 | ✔ 哈希未变 |
| `_rollback` | ✔ 哈希未变 |

### 当前 0.1.2 APK
```
apk/MOTION-0.1.2-release.apk
size   : 4061699
SHA256 : d4ed05a95ea2649066498b50aa6feafb3e69f58641f02d93f514c946dcb5d4a1
```
未重新构建、未重新签名、未安装、未操作手机。

---

## 7. 文档更新

- `GITHUB-SYNC.md`：第 3 节重写为迁移后事实（活动 gitdir、迁移步骤、回滚入口），
  纠正「只是理想方案未实现」措辞为「明确约束未满足，本轮已完成」。
- `MAINTENANCE.md`：新增 4 个原生测试说明（107 项）与活动 gitdir 位置。

---

## 8. 未完成 / 边界

| 项 | 状态 |
|---|---|
| 真机验收 | 未做。0.1.2 仅模拟器实证，需用户手机覆盖安装后长期反馈 |
| 旧 `.git-motion` 清理 | **未删除**（按要求保留为回滚来源） |
| 不合格备份副本 `git-motion/` | 保留但已标记，未删除 |
| 临时验证克隆 | 已清理 |

---

## 9. 本轮未做的事

未改 App 功能、未构建/签名/安装 APK、未操作手机数据、
未 `git reset`/`clean`/`force push`、未重写历史、未删旧原件、
未付费/部署、未改动其他仓库、未修改登录凭据。
