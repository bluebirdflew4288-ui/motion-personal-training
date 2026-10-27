/* 第2阶段 · 用**Codex 冻结的真实 v1 fixture** 验证兼容（场景 1 / 2）。

   可移植收尾（第3阶段，PHASE-3-IMPLEMENT「收尾新测试的可移植性」）：
   · 旧版本测试硬编码另一 Workspace 的 Codex 私有 Task 绝对路径，
     换机器/归档后即失效。现改为读取项目内副本
     `test/fixtures/synthetic-v1-backup.json`（相对 import.meta.url 的文件 URL）。
   · 副本是**纯合成**冻结原件的**逐字节复制**（cmp 已验证 BYTE-IDENTICAL），
     未修改/重生成 Codex 原件；原件位置与 SHA256 记录如下并在测试内自校验。
   · 旧断言一条不删、不跳过：新版接受 v1 备份并逐字段保真恢复、
     真实 0 / 稀疏组号 / 空 groups / 递减组 / active 原样、v2 导出不冲突。 */

import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { buildBackup, getSession, listSessions, restoreBackup, validateBackup } from '../src/db/repo';
import { sessionKindOf } from '../src/domain/sessionKind';

/** 项目内副本（相对路径，不依赖任何其他 Workspace） */
const FIXTURE_URL = new URL('./fixtures/synthetic-v1-backup.json', import.meta.url);
const FIXTURE_PATH = fileURLToPath(FIXTURE_URL);

/** 来源与完整性锚点（授权记录） */
const FIXTURE_ORIGIN =
  'Codex Task 2026-10-23_motion-training-expansion/independent/phase2-compat/synthetic-v1-backup.json（只读原件，未修改）';
const FIXTURE_SHA256 = 'd44f6307227ed79929648dcb6fb7f839246731788cc126ee69c2b15d4fa8fd36';

function fixtureText(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}
function loadFixture(): unknown {
  return JSON.parse(fixtureText());
}

describe('冻结 v1 fixture（项目内副本）来源核验', () => {
  it('副本 SHA256 与授权锚点一致（证明未改内容）', () => {
    const h = createHash('sha256').update(Buffer.from(fixtureText(), 'utf8')).digest('hex');
    expect(h, `来源：${FIXTURE_ORIGIN}`).toBe(FIXTURE_SHA256);
  });
});

beforeEach(async () => {
  __resetDbHandle();
  await idbClear('sessions');
  await idbClear('plans');
  await idbClear('meta');
  await idbClear('settings');
});

describe('冻结 v1 fixture 兼容', () => {
  it('新版接受该 v1 备份并保真恢复', async () => {
    const raw = loadFixture();
    const v = validateBackup(raw);
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
    if (!v.ok) return;

    // 恢复前记录原始会话（fixture 内的旧对象）
    const src = (raw as { data: { sessions: Array<Record<string, unknown>> } }).data.sessions;

    await restoreBackup(v.payload);
    const sessions = await listSessions();
    expect(sessions.length).toBe(src.length);

    // 逐条核验旧字段保真（真实 0 / 稀疏组号 / 空 groups / 递减组）
    for (const old of src) {
      const id = old.id as string;
      const after = await getSession(id);
      expect(after, `missing ${id}`).toBeDefined();
      // 类型归一为 strength（旧数据无 kind）
      expect(sessionKindOf(after!)).toBe('strength');
      expect(after!.cardio).toEqual([]);
      // 旧字段
      expect(after!.startedAt).toBe(old.startedAt);
      expect(after!.targetSetsAtStart).toBe(old.targetSetsAtStart ?? after!.targetSetsAtStart);
      expect(after!.exercises.length).toBe((old.exercises as unknown[]).length);

      // 逐组核验真实 0 与稀疏组号
      const oldExs = old.exercises as Array<Record<string, unknown>>;
      for (let i = 0; i < oldExs.length; i += 1) {
        const oldEx = oldExs[i];
        const newEx = after!.exercises[i];
        expect(newEx.name).toBe(oldEx.name);
        // 空 groups 不被复活
        const oldGroups = oldEx.groups as unknown[] | undefined;
        if (Array.isArray(oldGroups) && oldGroups.length === 0) {
          expect(newEx.groups).toEqual([]);
        }
        const oldSets = (oldEx.sets ?? []) as Array<Record<string, unknown>>;
        for (let j = 0; j < oldSets.length; j += 1) {
          // 真实 0 必须保留（不能被 `||` 默认覆盖）
          if (oldSets[j].reps === 0) expect(newEx.sets[j].reps).toBe(0);
          if (oldSets[j].weightKg === 0) expect(newEx.sets[j].weightKg).toBe(0);
          // 组号原样（稀疏组号不被重排）
          expect(newEx.sets[j].roundIndex).toBe(oldSets[j].roundIndex);
        }
      }
    }
  });

  it('新版导出的 v2 与 v1 输入不冲突（版本升到 2）', async () => {
    const v = validateBackup(loadFixture());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    await restoreBackup(v.payload);

    const b = await buildBackup('2.0.0');
    expect(b.version).toBe(2);
    // 导出的会话带上新字段（缺省值），且旧内容仍在
    for (const s of b.data.sessions) {
      expect(s.kind).toBe('strength');
      expect(Array.isArray(s.cardio)).toBe(true);
    }
  });
});
