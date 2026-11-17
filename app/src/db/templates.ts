/* 动作配置记忆（ExerciseTemplate）专属仓库（G1）。
   ── 边界 ────────────────────────────────────────────────────
   · 只使用既有 meta store，键前缀 `exercise-template:`，不升级 IndexedDB 版本；
   · 模板只保存**纯配置**：schemaVersion / 稳定身份 / name / target / restSec /
     revision / updatedAt；禁止 actual、status、runningSinceAt、计划来源；
   · 读取：坏模板**不静默丢弃**——备份导出走 `listExerciseTemplatesOrThrow()`，
     任一行损坏都明确失败，避免"导出成功但少了一条记忆"；
   · 写入：expectedRevision 冲突保护（null = 首次创建必须不存在）；
     成功只在 transaction.oncomplete 结算。 */

import { openDb, StorageError, idbGetAll } from './idb';
import type { ExerciseTemplate } from '../domain/types';
import {
  findTemplateContraband,
  parseExerciseTargetUnknown,
  validateExerciseTarget,
  type ConfigIssue,
} from '../domain/exerciseConfig';
import { MAX_EXERCISE_ID, MAX_PLAN_NAME, MAX_REST, MAX_STAGES_ACCEPTED } from '../domain/limits';

export const EXERCISE_TEMPLATE_PREFIX = 'exercise-template:';

export function exerciseTemplateKey(exerciseId: string): string {
  return `${EXERCISE_TEMPLATE_PREFIX}${exerciseId}`;
}

export function exerciseIdFromTemplateKey(key: string): string | null {
  if (!key.startsWith(EXERCISE_TEMPLATE_PREFIX)) return null;
  const id = key.slice(EXERCISE_TEMPLATE_PREFIX.length);
  return id || null;
}

interface RawMetaRow {
  key?: unknown;
  value?: unknown;
}

export type TemplateValidation =
  | { ok: true; template: ExerciseTemplate }
  | { ok: false; issues: ConfigIssue[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 校验并归一化一条模板。
 * 只允许已知字段，阶段必须有稳定 id（模板是新写入，不允许靠数组位置）。
 */
export function validateExerciseTemplate(raw: unknown): TemplateValidation {
  const issues: ConfigIssue[] = [];
  if (!isObj(raw)) return { ok: false, issues: [{ path: '', message: '动作模板必须是对象' }] };

  for (const issue of findTemplateContraband(raw)) issues.push(issue);

  if (raw.schemaVersion !== 1) {
    issues.push({ path: 'schemaVersion', message: '动作模板 schemaVersion 必须是 1' });
  }
  const exerciseId = typeof raw.exerciseId === 'string' ? raw.exerciseId.trim() : '';
  if (!exerciseId) issues.push({ path: 'exerciseId', message: '动作模板缺少稳定动作身份 exerciseId' });
  if (exerciseId.length > MAX_EXERCISE_ID) {
    // F1：与 SessionExercise.exerciseId 的备份边界一致（160）
    issues.push({ path: 'exerciseId', message: `动作模板 exerciseId 最多 ${MAX_EXERCISE_ID} 个字符` });
  }
  if (typeof raw.key !== 'string' || raw.key !== exerciseTemplateKey(exerciseId)) {
    issues.push({ path: 'key', message: `动作模板 key 必须是 ${EXERCISE_TEMPLATE_PREFIX}<exerciseId>` });
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) issues.push({ path: 'name', message: '动作模板缺少动作名' });
  if (name.length > MAX_PLAN_NAME) issues.push({ path: 'name', message: `动作名最多 ${MAX_PLAN_NAME} 个字符` });
  if (raw.en !== undefined && (typeof raw.en !== 'string' || raw.en.length > MAX_PLAN_NAME)) {
    issues.push({ path: 'en', message: `英文名最多 ${MAX_PLAN_NAME} 个字符` });
  }
  if (typeof raw.restSec !== 'number' || !Number.isInteger(raw.restSec) || raw.restSec < 0 || raw.restSec > MAX_REST) {
    issues.push({ path: 'restSec', message: `休息必须是 0–${MAX_REST} 秒的整数` });
  }
  if (typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 1) {
    // F2：必须是正的 safe integer；MAX_SAFE_INTEGER+1 不得被接受
    issues.push({ path: 'revision', message: '模板 revision 必须是正的 safe integer' });
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
    issues.push({ path: 'updatedAt', message: '模板 updatedAt 必须是有限数字' });
  }

  const parsedTarget = parseExerciseTargetUnknown(raw.target);
  let target: ExerciseTemplate['target'] | null = null;
  if (!parsedTarget.ok) {
    for (const issue of parsedTarget.issues) issues.push(issue);
  } else {
    target = parsedTarget.target;
    // 模板可能来自旧数据的 1–12 阶段结构；与全量备份 reader 的兼容边界一致
    const targetIssues = validateExerciseTarget(target, { minStages: 1, maxStages: MAX_STAGES_ACCEPTED });
    for (const issue of targetIssues) issues.push({ path: `target.${issue.path}`, message: issue.message });
    if (target.kind === 'dropSet') {
      target.stages.forEach((st, i) => {
        if (!st.id || !st.id.trim()) {
          issues.push({ path: `target.stages[${i}].id`, message: '动作模板的阶段必须有稳定 id' });
        }
      });
      (target.roundConfigs ?? []).forEach((rc, ri) => {
        rc.stages.forEach((st, i) => {
          if (!st.id || !st.id.trim()) {
            issues.push({ path: `target.roundConfigs[${ri}].stages[${i}].id`, message: '动作模板的逐轮阶段必须有稳定 id' });
          }
        });
      });
    }
  }

  if (issues.length || !target) return { ok: false, issues };
  return {
    ok: true,
    template: {
      key: raw.key as string,
      schemaVersion: 1,
      exerciseId,
      name,
      ...(raw.en !== undefined ? { en: raw.en as string } : {}),
      target,
      restSec: raw.restSec as number,
      revision: raw.revision as number,
      updatedAt: raw.updatedAt as number,
    },
  };
}

export interface TemplateRepositorySnapshot {
  templates: ExerciseTemplate[];
  /** 损坏的行：明确列出，不静默丢弃 */
  invalid: Array<{ key: string; issues: ConfigIssue[] }>;
}

/** 读取全部模板行（含损坏行诊断）。 */
export async function readExerciseTemplates(): Promise<TemplateRepositorySnapshot> {
  const rows = await idbGetAll<RawMetaRow>('meta');
  const templates: ExerciseTemplate[] = [];
  const invalid: TemplateRepositorySnapshot['invalid'] = [];
  for (const row of rows) {
    const key = typeof row.key === 'string' ? row.key : '';
    if (!key.startsWith(EXERCISE_TEMPLATE_PREFIX)) continue;
    const parsed = validateExerciseTemplate(row.value);
    if (parsed.ok) templates.push(parsed.template);
    else invalid.push({ key, issues: parsed.issues });
  }
  return { templates, invalid };
}

/** UI 列表用：只返回合法模板。 */
export async function listExerciseTemplates(): Promise<ExerciseTemplate[]> {
  return (await readExerciseTemplates()).templates;
}

/**
 * 备份 / 导出用：任一行模板损坏即明确失败。
 * 绝不"导出成功但少一条记忆"。
 */
export async function listExerciseTemplatesOrThrow(): Promise<ExerciseTemplate[]> {
  const snap = await readExerciseTemplates();
  if (snap.invalid.length) {
    const first = snap.invalid[0];
    throw new StorageError(
      `动作配置记忆中有损坏项（${first.key}: ${first.issues[0]?.message ?? '结构不合法'}），已停止导出，避免静默丢数据`,
    );
  }
  return snap.templates;
}

export async function getExerciseTemplate(exerciseId: string): Promise<ExerciseTemplate | undefined> {
  return (await listExerciseTemplates()).find((t) => t.exerciseId === exerciseId);
}

export type TemplateWriteResult =
  | { ok: true; template: ExerciseTemplate }
  | { ok: false; reason: 'version-conflict' | 'storage' | 'invalid'; message: string; current?: ExerciseTemplate };

/**
 * 原子写入/更新一条模板（独立入口，供 G2 明确"记住本次配置"使用）。
 * @param input 目标模板（revision 可占位；写入时按 expectedRevision 计算）
 * @param expectedRevision null = 首次创建（必须不存在）；number = 必须与现有 revision 相等
 */
export function putExerciseTemplate(
  input: ExerciseTemplate,
  expectedRevision: number | null,
): Promise<TemplateWriteResult> {
  /**
   * F2：独立 repo 也必须检查「计算后的 nextRevision」，不能只校验入参 revision。
   * MAX_SAFE_INTEGER 时 +1 会变成不安全的 9007199254740992：
   * 明确拒绝（不 clamp/截断/重编号），原模板不变。
   */
  const nextRevision = expectedRevision === null ? 1 : expectedRevision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision < 1) {
    return Promise.resolve({
      ok: false,
      reason: 'version-conflict',
      message: '动作配置记忆的 revision 已达安全整数上限，无法安全递增；本页没有写入任何改动',
    });
  }
  const candidate: ExerciseTemplate = {
    ...input,
    key: exerciseTemplateKey(input.exerciseId),
    schemaVersion: 1,
    revision: nextRevision,
  };
  const pre = validateExerciseTemplate(candidate);
  if (!pre.ok) {
    return Promise.resolve({
      ok: false,
      reason: 'invalid',
      message: `动作模板不合法：${pre.issues[0]?.path ?? ''} — ${pre.issues[0]?.message ?? ''}`,
    });
  }

  return openDb().then(
    (db) =>
      new Promise<TemplateWriteResult>((resolve) => {
        let settled = false;
        const done = (r: TemplateWriteResult) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        let t: IDBTransaction;
        try {
          t = db.transaction('meta', 'readwrite');
        } catch (err) {
          done({ ok: false, reason: 'storage', message: err instanceof Error ? err.message : '事务开启失败' });
          return;
        }
        const store = t.objectStore('meta');
        let pending: ExerciseTemplate | null = null;
        const getReq = store.get(candidate.key);
        getReq.onerror = () => done({ ok: false, reason: 'storage', message: '读取动作模板失败' });
        getReq.onsuccess = () => {
          const row = getReq.result as RawMetaRow | undefined;
          const currentParsed = row ? validateExerciseTemplate(row.value) : null;
          const current = currentParsed && currentParsed.ok ? currentParsed.template : undefined;
          if (row && !current) {
            done({ ok: false, reason: 'invalid', message: '现有动作模板已损坏，请先修复或删除后再保存' });
            return;
          }
          const actualRev = current?.revision ?? null;
          if (expectedRevision === null) {
            if (actualRev !== null) {
              done({
                ok: false,
                reason: 'version-conflict',
                message: '这条动作配置已经有记忆了（可能另一个页面刚保存过），本页没有覆盖它；请刷新后重试',
                ...(current ? { current } : {}),
              });
              return;
            }
          } else if (actualRev !== expectedRevision) {
            done({
              ok: false,
              reason: 'version-conflict',
              message: '动作配置记忆已被更新（可能在另一个页面改过），本页没有覆盖新数据；请刷新后重试',
              ...(current ? { current } : {}),
            });
            return;
          }
          try {
            store.put({ key: candidate.key, value: candidate });
            pending = candidate;
          } catch (err) {
            done({ ok: false, reason: 'storage', message: err instanceof Error ? err.message : '写入失败' });
          }
        };
        t.oncomplete = () => {
          if (pending) done({ ok: true, template: pending });
          else done({ ok: false, reason: 'storage', message: '事务提交但未写入模板' });
        };
        t.onabort = () => done({ ok: false, reason: 'storage', message: t.error?.message ?? '事务被中止，模板未保存' });
        t.onerror = () => done({ ok: false, reason: 'storage', message: t.error?.message ?? '写入失败' });
      }),
  );
}

/** 删除一条模板（expectedRevision 可选，用于并发保护） */
export function deleteExerciseTemplate(
  exerciseId: string,
  expectedRevision?: number,
): Promise<{ ok: boolean; message?: string }> {
  const key = exerciseTemplateKey(exerciseId);
  return openDb().then(
    (db) =>
      new Promise<{ ok: boolean; message?: string }>((resolve) => {
        let settled = false;
        const done = (r: { ok: boolean; message?: string }) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        let t: IDBTransaction;
        try {
          t = db.transaction('meta', 'readwrite');
        } catch (err) {
          done({ ok: false, message: err instanceof Error ? err.message : '事务开启失败' });
          return;
        }
        const store = t.objectStore('meta');
        const getReq = store.get(key);
        getReq.onsuccess = () => {
          const row = getReq.result as RawMetaRow | undefined;
          if (!row) {
            done({ ok: false, message: '动作配置记忆不存在' });
            return;
          }
          if (expectedRevision !== undefined) {
            const parsed = validateExerciseTemplate(row.value);
            if (!parsed.ok || parsed.template.revision !== expectedRevision) {
              done({ ok: false, message: '动作配置记忆已被更新，本页没有删除新数据' });
              return;
            }
          }
          store.delete(key);
        };
        getReq.onerror = () => done({ ok: false, message: '读取动作模板失败' });
        t.oncomplete = () => done({ ok: true });
        t.onabort = () => done({ ok: false, message: t.error?.message ?? '事务被中止，模板未删除' });
        t.onerror = () => done({ ok: false, message: t.error?.message ?? '删除失败' });
      }),
  );
}
