# MOTION 项目收尾整理记录

时间：2026-10-22 19:05 CST
范围：**仅本项目**。未开发、未重构、未重建 APK、未安装、未操作手机或训练数据。
权限：保持工作区内修改，未扩大权限。

---

## 1. 调查结论（先查后动）

### 候选临时物（逐个核实，不按名字猜测）
| 路径 | 类型 | 文件数 | 字节 | 引用检查结果 |
|---|---|---|---|---|
| `app/.patch/` | dir | 9 | 21158 | **无引用**（精确 grep `.patch/` 于 scripts/src/test/android/*.md 均无命中） |
| `app/.probe/` | dir | 1 | 1185 | **无引用** |
| `app/.prevalidate.mjs` | file | 1 | 2868 | 仅 `verify-zero-byte/BUILD-REPORT-012.md` 文本提到命令，非脚本依赖 |
| `app/android/native-test/out/` | dir | 19 | 57506 | **脚本会自动重建**（`test-native.mjs` 每次 `rmSync`+`mkdirSync`） |

> 注：初查时 `grep "\.patch"` 命中的 `{...patch}` 是源码里的对象展开变量，
> 与临时目录无关；已用带分隔符的精确路径重新确认。

### 明确保留（有依赖或属证据）
- **`_rollback/` 全部 13 个快照** —— 关键：`app/test/v4-backup.test.ts` 与
  `v5-migrate-delete.test.ts` 在运行时**动态 import**
  `_rollback/v2-snapshot-20261021b/src/domain/`，删除会断链。
- `app/src`、`app/test`、`app/android/app/src`、`app/public`（23 文件）、
  `app/package-lock.json`、`app/node_modules`、`app/scripts`。
- `apk/` 全部 4 个包、`app/dist`～`dist-v8`（8 个）、`app/dist-android`、`app/dist-baseline-011`。
- 全部 `verify*/` 验收目录、所有 `*.md` 历史报告。
- SDK / JDK / Gradle / `~/.motion-android-signing` / AVD（项目外，未触碰）。
- 运行中的 5999 端口服务（未停止）。

---

## 2. 归档清单（仅移动，未删除）

归档位置：`_archive/maintenance-20261022/`

### 2.1 可恢复 tar 包
```
_archive/maintenance-20261022/temp-workdirs-20261022.tar.gz
  size   : 32421 bytes
  SHA256 : 3783ed2b03a345f274286aba5128abda2263af9958d31a3119b8685f68078a8c
  成员   : 30 个文件（app/.patch×9, app/.probe×1, app/.prevalidate.mjs×1,
           app/android/native-test/out×19）
```

### 2.2 从工作树移走的原样副本
```
_archive/maintenance-20261022/removed-from-tree/
  app/.patch/                             (9 文件)
  app/.probe/                             (1 文件)
  app/.prevalidate.mjs                    (1 文件)
  app/android/native-test/out/            (19 文件)
  合计 30 文件 / 82717 字节
```

> **补充说明（重要）**：`app/android/native-test/out/` 在归档后又被
> `node scripts/test-native.mjs` **自动重建**了一次（这是脚本设计行为：
> 每次运行先 `rmSync` 再 `mkdirSync` 再 `javac -d`）。
> 因此**当前工作树中该目录是存在且被保留的**（19 文件 / 57506 字节），
> 并不是「已从工作树移走」的状态。归档副本同时保留，两者内容对应同一次编译。
> 这属于自动再生的构建缓存，**无需也不应反复删除**。

### 2.3 清单与基线证明
```
_archive/maintenance-20261022/archive-member-manifest.txt       每个成员的原始相对路径/大小/SHA256
_archive/maintenance-20261022/protected-baseline-before.txt     整理前 210 行保护基线
_archive/maintenance-20261022/protected-baseline-after.txt      整理后 210 行保护基线
```

### 2.4 归档校验（全部通过）
- **成员数**：清单 30 / tar 解出 30 → 一致
- **逐文件 SHA256**：30/30 全部一致
- **恢复演练**：解包到临时目录，路径结构与关键文件均正确
- 校验通过后才移动原目录

---

## 3. 恢复命令（安全做法：先解到空目录核验）

```bash
cd "/Volumes/阿钰的移动硬盘/AI通用工作区/DeepSeek Harness Workspace/tasks/2026-10-20_motion-training-app"

# 1) 解到新建的空目录 —— 目标必须不存在，存在则拒绝覆盖
RESTORE_TMP="_archive/_restore-check-$(date +%Y%m%d-%H%M%S)"
[ -e "$RESTORE_TMP" ] && { echo "目标已存在，拒绝覆盖"; exit 1; }
mkdir -p "$RESTORE_TMP"
tar -xzf _archive/maintenance-20261022/temp-workdirs-20261022.tar.gz -C "$RESTORE_TMP"

# 2) 核验：对照 archive-member-manifest.txt 检查每个文件 SHA256
find "$RESTORE_TMP" -type f ! -name '._*' | sort | while read f; do
  shasum -a 256 "$f"
done

# 3) 确认无误后再按需拷回（示例：仅补回 .patch）
# cp -Rp "$RESTORE_TMP"/app/.patch app/
```

### 若要直接解包到项目：用 `tar -k`
```bash
tar -kxzf _archive/maintenance-20261022/temp-workdirs-20261022.tar.gz -C .
```
`-k` / `--keep-old-files` 的行为：**已存在的文件会被跳过、绝不覆盖**，
只补充缺失文件。若需强制还原归档版本，必须先自行移走目标路径再解包。

或直接从 `removed-from-tree/` 拷回（内容与 tar 相同）。

> `app/android/native-test/out/` **不需要**手工恢复：
> 下次运行 `node app/scripts/test-native.mjs` 会自动重建（当前已在工作树中）。

---

## 4. 保护证明（整理前后逐字节一致）

基线覆盖 210 行哈希，`diff` 结果 **完全一致**：

| 类别 | 内容 | 结论 |
|---|---|---|
| APK | `apk/*.apk` 4 个 | ✔ 未变 |
| 源码/配置 | `package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`vitest.config.ts`、`capacitor.config.ts`、`index.html`、`android/app/build.gradle` | ✔ 未变 |
| `app/src` + `app/test` | 递归全部文件 | ✔ 未变 |
| Android 原生源码 | `app/android/app/src` 递归 | ✔ 未变 |
| 构建/验证脚本 | `app/scripts/*.mjs` | ✔ 未变 |

### dist 目录哈希（整理前后相同）
```
app/dist                  e454c9003f70873e
app/dist-v2               1acf49a59037cfe3
app/dist-v3               428a96bc8f23edf4
app/dist-v4               e46dd2ea0789423f
app/dist-v5               2393fa3682a97b2e
app/dist-v6               bc9364e3066b25f0
app/dist-v7               e7583fabb748dddf
app/dist-v8               fc151fb784239502
app/dist-android          7cbe9afdc6a793a2
app/dist-baseline-011     d42edb44a2f9643a
```

### `_rollback/` 未触碰
13 个快照全部保留，`v2-snapshot-20261021b/src` 38 文件完好，
`app/test/v4-backup.test.ts` / `v5-migrate-delete.test.ts` 的动态 import 链路未断。

### APK 哈希（未变）
```
5756a3a5f1a67674ad2033322872a706fc3cc093365d3dbbc5ee459a11152ebf  MOTION-0.1.0-debug.apk
cb25f7665d1a2fb94c499192907bbee2ce38e1a9a8e703b31f3c122f00c3a330  MOTION-0.1.0-release.apk
813258b8e1bc94c6db082c1cecd3b7da930bfd7af9f618cbac8d32771bc05212  MOTION-0.1.1-release.apk
d4ed05a95ea2649066498b50aa6feafb3e69f58641f02d93f514c946dcb5d4a1  MOTION-0.1.2-release.apk
```

---

## 5. 功能验证（只验证被整理路径的引用与恢复）

- **`test-native.mjs` 在 `out/` 移走后仍可用**：
  实跑 → `PASS=24`、`ExportSpoolTest PASS=58`、`ExportPhaseTest PASS=13`、
  `ExportOriginalBindingTest PASS=12`，并**自动重建** `out/`（19 文件）。
- **归档可恢复**：tar 解包演练通过，30/30 哈希一致。
- 未重跑全部历史测试（按要求）。

---

## 6. 新增/修改的文件

| 文件 | 动作 |
|---|---|
| `MAINTENANCE.md` | **新增**（唯一「继续维护」入口） |
| `README.md` | 顶部**新增 3 行**指向 MAINTENANCE.md；原有内容一字未改 |
| `CLEANUP.md` | **新增**（本文件） |
| `_archive/maintenance-20261022/` | **新增**（归档目录） |

历史报告、截图、JSON 证据全部原样保留，未覆盖、未改写。

---

## 7. 关于磁盘空间（如实说明）

本次**只是移动**（`app/` → `_archive/`），**没有释放磁盘空间**。
唯一真正删除的是 `/tmp` 下的临时校验副本（系统临时目录，非项目内）。

若将来确认这些临时补丁不再需要，可安全删除：
```
_archive/maintenance-20261022/removed-from-tree/
_archive/maintenance-20261022/temp-workdirs-20261022.tar.gz   # 二选一，建议留 tar
```
删除后 `app/android/native-test/out/` 仍会自动重建，不影响任何脚本。

---

## 8. 未做的事

- 未清理 AppleDouble（`._*`）—— 按要求不做，且构建脚本会自行处理
- 未使用 `rm` 通配 / `git clean`
- 未停止运行中的服务（5999 端口仍在）
- 未触碰 `node_modules`、SDK/JDK/Gradle、签名目录、AVD
- 未提交、未推送、未部署、未新增 Agent、未扩大到其他 Workspace
