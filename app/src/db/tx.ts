/* 训练记录的唯一受约束写入入口（V3-01）。
   设计目标（对应独立审查 D12–D20）：
   1) 锁只有一种 schema（见 ./locks.ts），获取/续租/释放/保存校验全在原子事务里。
   2) 每条记录有单调 revision；写入方带 expectedRevision，同事务读 current → 核验 → 写。
   3) 新建 / 活动保存 / 结束 / 放弃 / 历史纠错**各自定义允许的状态转换**，
      已终态（completed/discarded）不能被旧的 active 快照复活。
   4) 结束幂等是数据层无条件成立的：已结束记录返回原结果，不再写、不推进游标。
   5) 计划推进在事务内从**最新计划**计算，不信任 UI 预先算好的整份 plan 快照。
   6) 失败整体回滚；重试不会重复推进。

   跨 store 说明：结束 = 写训练终态 + 可能推进计划，两者必须在同一个 transaction 里，
   任一失败整体 abort（审查 D16 已验证的方向，这里保留并加强）。 */

import { openDb, StorageError } from './idb';
import {
  atomicAcquireOrRenew,
  atomicRenew,
  atomicRelease,
  lockGrantsWrite,
  interpretLock,
  lockKey,
  readLockState,
  DEFAULT_LOCK_TTL_MS,
  type LockOpResult,
} from './locks';
import { pushCycle } from '../domain/cycle';
import type { ExerciseTemplate, Plan, Session } from '../domain/types';
import { localDateKey } from '../domain/localDate';
import { finalizeCardioForFinish } from '../domain/cardio';
import { hasAnyRealContent } from '../domain/sessionContent';
import { applySessionArrangementToPlan } from '../domain/sessionToPlanSync';
import { MAX_CARDIO_ENTRIES, MAX_PLANS } from '../domain/limits';
import { validateExerciseTemplate } from './templates';

export type WriteFailureReason =
  | 'lock-lost'
  | 'no-lock'
  | 'corrupt-lock'
  | 'version-conflict'
  | 'state-conflict'
  | 'storage';

export type WriteResult =
  | {
      ok: true;
      /** 写入后记录的 revision（幂等结束返回既有值） */
      revision: number;
      /** 落库后的记录（结束/放弃时基于事务内最新记录合并，而非调用方旧快照） */
      session: Session;
      /** 结束并推进后的计划（未推进时为事务内当前计划） */
      plan?: Plan;
      /** true = 记录本来已是终态，本次没有写入 */
      alreadyTerminal?: boolean;
      /** 与本次写入同事务提交的模板（若请求了 templateWrite） */
      template?: ExerciseTemplate;
    }
  | {
      ok: false;
      reason: WriteFailureReason;
      message: string;
      /** 事务内读到的最新记录，便于 UI 提示「刷新后查看」 */
      current?: Session;
    };

/** 写入意图：每种意图对应一组明确允许的状态转换 */
export type WriteIntent =
  /** 新建一次训练：允许记录不存在；不允许覆盖已存在的记录 */
  | { kind: 'create' }
  /** 训练进行中的普通保存：当前必须是 active */
  | { kind: 'active-save' }
  /**
   * 结束训练：当前必须是 active；已终态则幂等返回既有结果且不推进。
   *
   * **有氧封口是无条件的**（G5）：只要库内 current 有 running 的有氧，
   * 就在本事务内以 current + 捕获的完成时刻结算最后一段。
   * 旧实现用可选 `finalizeCardio` flag，任何漏传的 UI 入口都会留下
   * "终态但仍有 running/未封口段"的损坏记录 —— 因此不再提供关闭开关。
   */
  | { kind: 'finish'; advanceCycle: boolean; syncBackToPlanDay?: boolean }
  /** 放弃训练：当前必须是 active；已终态则幂等返回 */
  | { kind: 'discard' }
  /** 历史纠错：当前必须是终态记录；只改当下合法版本 */
  | { kind: 'history-edit' }
  /** 记录完全休息：同事务内做同日去重/冲突核验，并按需推进一次循环 */
  | { kind: 'create-rest'; restDate: string; advanceCycle: boolean }
  /** 撤销完全休息：只删该 rest 记录，不碰真实训练、不回退 cursor */
  | { kind: 'delete-rest'; restDate: string };

export interface WriteOptions {
  intent: WriteIntent;
  /** 要写入的记录内容 */
  session: Session;
  /** 写入方 editorId（锁校验用）；history-edit / create 可为空 */
  editorId?: string;
  /** 期望的当前 revision；不传=不校验（仅 create/finish 允许省略） */
  expectedRevision?: number;
  /** 锁校验级别：required（默认，训练进行中）/ optional（历史纠错、首页结束引导确认后） */
  lockPolicy?: 'required' | 'optional';
  /** 锁租期 */
  ttlMs?: number;
  /**
   * 可选：与本次 session 修改**同一事务**写入的动作配置记忆（G1）。
   * · expectedRevision = null → 首次创建，必须不存在；
   * · expectedRevision = number → 必须与现有 revision 相等；
   * · 任一冲突 / 写入失败 → 整个事务 abort，session 与模板一起回滚。
   */
  templateWrite?: {
    template: ExerciseTemplate;
    expectedRevision: number | null;
  };
}

/**
 * 读取出口的**纯内存缺省**（G6）。
 *
 * 与 `repo.normalizeSession` 同一套语义，但 tx 不 import repo（避免循环依赖），
 * 因此在这里保留一份等价实现。**只补缺省，不回写库、不重建 groups/目标分母。**
 */
function withDefaults(s: Session | undefined): Session | undefined {
  if (!s) return undefined;
  return {
    ...s,
    kind: s.kind ?? 'strength',
    origin: s.origin ?? 'plan',
    cardio: s.cardio ?? [],
    cardioPausedBySession: s.cardioPausedBySession ?? [],
  };
}

/**
 * 会话级有氧不变量的**写入边界核验**（G3）。
 *
 * 旧实现只在渲染时 disabled，于是快速输入仍能把**两个 running**
 * 或**超过 8 项**的有氧写进库 —— 结果应用自产的备份被自己的校验拒绝、无法恢复。
 * 因此在真正写入前统一核验；非法一律拒绝并给明确原因，
 * 不关闭校验、也不静默暂停另一项来"求绿"。
 */
function cardioWriteViolation(next: Session): string | null {
  const list = next.cardio ?? [];
  if (list.length > MAX_CARDIO_ENTRIES) {
    return `一次训练最多 ${MAX_CARDIO_ENTRIES} 个有氧项目`;
  }
  const running = list.filter((c) => c.status === 'running').length;
  if (running > 1) {
    return '一次训练只能有一个正在计时的有氧项目，请先暂停或完成当前项目';
  }
  return null;
}

/** 记录当前 revision（旧数据视为 0） */
export function revisionOf(s: Session | undefined): number {
  return typeof s?.revision === 'number' && Number.isFinite(s.revision) ? s.revision : 0;
}

function fail(
  reason: WriteFailureReason,
  message: string,
  current?: Session,
): { ok: false; reason: WriteFailureReason; message: string; current?: Session } {
  const cur = withDefaults(current);
  return { ok: false, reason, message, ...(cur ? { current: cur } : {}) };
}

/**
 * 在**同一个** IndexedDB 事务里：读锁 → 读当前记录 →（结束还需）读最新计划 → 核验 → 写。
 * 所有判断都在 request 的 onsuccess 里同步完成，保证事务不被提前提交。
 */
export function atomicWriteSession(opts: WriteOptions): Promise<WriteResult> {
  const { intent, session, editorId, expectedRevision, lockPolicy = 'required', ttlMs = DEFAULT_LOCK_TTL_MS, templateWrite } = opts;
  /**
   * G1-PRE-REVIEW #3：原子写入口不能绕过模板权威校验。
   * 在开启事务前按与 putExerciseTemplate 相同的 validateExerciseTemplate 校验
   * （schemaVersion / key 前缀 / 纯配置白名单 / target 结构 / 名称边界）；
   * 非法直接失败，Session / revision / meta 都不变。
   */
  if (templateWrite) {
    /**
     * F2：成对原子保存同样必须校验「计算后的 nextRevision」。
     * 已有模板 revision=MAX_SAFE_INTEGER 时 +1 不安全，必须在开启事务前拒绝，
     * 保证 Session / revision / meta 全部保持原值（不 clamp / 截断 / 重编号）。
     */
    const nextRevision = templateWrite.expectedRevision === null ? 1 : templateWrite.expectedRevision + 1;
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 1) {
      return Promise.resolve(
        fail(
          'version-conflict',
          '动作配置记忆的 revision 已达安全整数上限，无法安全递增；本次训练修改与模板写入均已取消',
        ),
      );
    }
    const parsed = validateExerciseTemplate(templateWrite.template);
    if (!parsed.ok) {
      const first = parsed.issues[0];
      return Promise.resolve(
        fail('storage', `动作模板不合法，已拒绝写入：${first ? `${first.path} — ${first.message}` : '结构不合法'}`),
      );
    }
  }
  const needsPlans = intent.kind === 'finish' || intent.kind === 'create-rest';
  const stores = needsPlans ? ['sessions', 'meta', 'plans'] : ['sessions', 'meta'];
  /**
   * 需要读全部 sessions 做**同日互斥**核验的意图：
   * · create      普通开练（力量/有氧）—— 同日已有 rest 时必须拒绝（G1 反向互斥）
   * · create-rest 记录休息 —— 同日已有实际训练/active 时必须拒绝
   * · delete-rest 撤销休息 —— 需要按稳定身份核验
   */
  const needsAllSessions =
    intent.kind === 'create' ||
    intent.kind === 'create-rest' ||
    intent.kind === 'delete-rest';

  return openDb().then(
    (db) =>
      new Promise<WriteResult>((resolve) => {
        let settled = false;
        const done = (r: WriteResult) => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        /**
         * 拟返回的成功结果（V4-01）。
         * 关键：put 请求 even 单个成功都不等于「事务已提交」。
         * 因此所有写分支只把结果暂存在这里，**只有 transaction.oncomplete**
         * 才 resolve 成功；onabort/onerror 一律返回失败。
         * 审查 V4D12：finish 分支曾经在 put 之后直接 done(ok)，
         * 导致提交前 abort 时调用方已收到成功、store 已更新内存。
         */
        let pendingSuccess: WriteResult | null = null;
        /** 不需要写库就能确定的成功结果（幂等终态）—— 它不依赖事务提交 */
        let immediateSuccess: WriteResult | null = null;
        /** 与本次 session 同事务写入的模板（仅在提交后交给调用方） */
        let pendingTemplate: ExerciseTemplate | undefined;

        let t: IDBTransaction;
        try {
          t = db.transaction(stores, 'readwrite');
        } catch (err) {
          done(fail('storage', err instanceof Error ? err.message : '事务开启失败'));
          return;
        }
        const sessions = t.objectStore('sessions');
        const meta = t.objectStore('meta');
        const plans = needsPlans ? t.objectStore('plans') : null;

        const abort = (r: WriteResult) => {
          // 主动失败：先清掉暂存的成功，避免 oncomplete 抢答（正常 abort 不会触发 oncomplete）
          pendingSuccess = null;
          immediateSuccess = null;
          pendingTemplate = undefined;
          try {
            t.abort();
          } catch {
            /* ignore */
          }
          done(r);
        };

        // 唯一的成功出口：事务真正提交后才把暂存结果交回调用方
        t.oncomplete = () => {
          if (pendingSuccess) {
            done(pendingSuccess);
            return;
          }
          if (immediateSuccess) {
            done(immediateSuccess);
            return;
          }
          done(fail('storage', '事务提交但未产生结果'));
        };
        t.onabort = () => {
          if (settled) return;
          settled = true;
          // 提交阶段失败：即使某个 put 的 request 曾 success，也必须报告失败
          pendingSuccess = null;
          resolve(fail('storage', t.error?.message ?? '事务被中止，数据未保存'));
        };
        t.onerror = () => abort(fail('storage', t.error?.message ?? '写入失败'));

        const lockReq = meta.get(lockKey(session.id));
        const curReq = sessions.get(session.id);
        /** rest 相关：需要全部 sessions 做同日去重/冲突核验（同一事务内决定） */
        const allReq = needsAllSessions ? sessions.getAll() : null;
        /** 可选模板：在同一事务内读取当前 revision，用于 expected revision 冲突保护 */
        const templateReq = templateWrite ? meta.get(templateWrite.template.key) : null;

        let lockRaw: unknown;
        let current: Session | undefined;
        let allSessions: Session[] | undefined;
        let templateRaw: unknown;
        let pending = (needsAllSessions ? 3 : 2) + (templateWrite ? 1 : 0);

        if (allReq) {
          allReq.onsuccess = () => {
            allSessions = allReq.result as Session[];
            step();
          };
        }
        if (templateReq) {
          templateReq.onsuccess = () => {
            templateRaw = templateReq.result;
            step();
          };
          templateReq.onerror = () => abort(fail('storage', '无法读取动作配置记忆'));
        }

        const step = () => {
          pending--;
          if (pending > 0) return;
          const now = Date.now();

          // ── ⓪ 状态前置判定 ──
          // 只做「确定不写」的判断，让 UI 拿到准确原因，不构成写入授权。
          // · active-save 命中终态记录 → 已结束/已放弃，直接拒绝（审查 D14）
          // · finish/discard 命中终态记录 → 幂等返回既有结果，不写不推进（审查 D18）
          if (intent.kind === 'active-save') {
            if (!current) {
              abort(fail('state-conflict', '找不到这条训练记录，可能已被删除', current));
              return;
            }
            if (current.status !== 'active') {
              abort(
                fail(
                  'state-conflict',
                  current.status === 'completed' ? '这条训练已经结束，请刷新后查看' : '这条训练已经放弃，请刷新后查看',
                  current,
                ),
              );
              return;
            }
          }

          // ── ① 锁资格 ──
          // required：必须持有、未过期、结构合法（缺失/损坏/过期/非持有者一律拒绝，审查 D17/D13）。
          // optional：**只表示「允许无锁」**，不表示「可以无视别人正在持有的有效锁」（审查 V4D11）。
          //   → 锁空闲 / 已过期 / 属于自己 才放行；别人有效持锁必须拒绝。
          //   这样首页两步式「先查锁再 optional 结束」之间的竞争窗口在事务内被封住。
          // 唯一例外：finish/discard 命中已终态记录时不写入，允许无锁返回既有结果。
          const terminalNoop =
            (intent.kind === 'finish' || intent.kind === 'discard') && !!current && current.status !== 'active';
          if (lockPolicy === 'optional' && !terminalNoop) {
            const st = interpretLock(lockRaw, now, ttlMs);
            if (st.kind === 'corrupt') {
              abort(fail('corrupt-lock', '编辑锁记录已损坏，请刷新页面重新取得控制', current));
              return;
            }
            if (st.kind === 'held' && st.editorId !== (editorId ?? '') && !st.expired) {
              abort(
                fail(
                  'lock-lost',
                  '这条训练正在另一个标签页中编辑，本页不会结束它。请回到那个标签页操作，或等它停止编辑后再试。',
                  current,
                ),
              );
              return;
            }
          }
          /**
           * rest 相关意图不针对"正在编辑的训练"，因此不走训练编辑锁校验；
           * 它们的并发安全由**同一事务内的同日去重/冲突核验**保证
           * （两页同时 create-rest 时，后一个会读到前一个已写入的 rest 并拒绝）。
           */
          const skipTrainingLock = intent.kind === 'create-rest' || intent.kind === 'delete-rest';
          if (lockPolicy === 'required' && !terminalNoop && !skipTrainingLock) {
            const st = interpretLock(lockRaw, now, ttlMs);
            if (st.kind === 'corrupt') {
              abort(fail('corrupt-lock', '编辑锁记录已损坏，请刷新页面重新取得控制', current));
              return;
            }
            if (st.kind !== 'held') {
              abort(fail('no-lock', '本页没有这个训练的编辑锁，不能写入。请刷新后重新取得控制。', current));
              return;
            }
            if (!lockGrantsWrite(lockRaw, editorId ?? '', now, ttlMs)) {
              abort(
                fail(
                  'lock-lost',
                  st.editorId === editorId
                    ? '编辑锁已过期，请重新取得控制后再保存'
                    : '这个训练已在另一个标签页中被接管，本页不再写入',
                  current,
                ),
              );
              return;
            }
          }

          // ── ② 状态转换与版本 ──
          const curStatus = current?.status;
          const curRev = revisionOf(current);

          switch (intent.kind) {
            /**
             * 记录完全休息（第2阶段）。
             *
             * 在**同一事务**内完成：同日去重（跨计划）→ 与 active/实际训练互斥核验
             * → 读最新 plan → 按 advanceCycle 推进一次 → 写入 rest 记录。
             * 因为 rest 创建即 completed，后续 finish 必 no-op，
             * 所以推进必须在这里完成。
             */
            case 'create-rest': {
              const list = allSessions ?? [];
              const restDate = intent.restDate;
              // ① 同日已有 rest → 幂等拒绝（跨计划去重）
              const sameRest = list.find(
                (x) => x.status !== 'discarded' && (x.kind ?? 'strength') === 'rest' && x.restDate === restDate,
              );
              if (sameRest) {
                abort(fail('state-conflict', '今天已经记录过完全休息了', sameRest));
                return;
              }
              // ② 存在未结束训练 → 必须先处理其锁/草稿
              const active = list.find((x) => x.status === 'active');
              if (active) {
                abort(fail('state-conflict', '还有一次训练没有结束，请先结束或放弃它，再记录完全休息', active));
                return;
              }
              /**
               * ③ 同日有**真实内容**的记录 → 强互斥。
               *
               * G1：旧实现用 `status === 'discarded'` 直接跳过，
               * 于是"已放弃但仍有 8 次 × 20kg 递减阶段"的记录会被当成没练，
               * 让同一天既能记休息又有真实运动数据。
               * 现在用 `hasAnyRealContent`（含 partial / 只填重量 / 真实 0 /
               * 备注 / 热身 / 有氧）判断，**不看 status 标签**。
               */
              const sameDayReal = list.find((x) => {
                if ((x.kind ?? 'strength') === 'rest') return false;
                const ts = x.endedAt ?? x.startedAt;
                const sameDay =
                  localDateKey(x.startedAt) === restDate || localDateKey(ts) === restDate;
                if (!sameDay) return false;
                return hasAnyRealContent(x);
              });
              if (sameDayReal) {
                abort(
                  fail('state-conflict', '今天已有实际训练记录，不能同时标记为完全休息', sameDayReal),
                );
                return;
              }
              // ④ 读最新 plan → 按明确意图推进一次
              const planId = session.planId;
              const planReq = plans!.get(planId);
              planReq.onsuccess = () => {
                const curPlan = planReq.result as Plan | undefined;
                const shouldAdvance = intent.advanceCycle && !!curPlan && curPlan.days.length > 0;
                const movedPlan = shouldAdvance && curPlan ? pushCycle(curPlan) : undefined;
                const next: Session = {
                  ...session,
                  status: 'completed',
                  endedAt: session.endedAt ?? now,
                  advancedCycle: Boolean(shouldAdvance),
                  cycleIndexAfter: movedPlan ? movedPlan.cursor : (curPlan?.cursor ?? session.cycleIndexAtStart),
                  revision: 1,
                };
                try {
                  sessions.put(next);
                  if (movedPlan && curPlan) plans!.put({ ...curPlan, ...movedPlan });
                } catch (err) {
                  abort(fail('storage', err instanceof Error ? err.message : '写入失败', current));
                  return;
                }
                finishWrite({ ok: true, revision: 1, session: next });
              };
              return;
            }
            /**
             * 撤销完全休息：只删该 rest 记录。
             * **不碰真实训练、不回退 cursor**（文案说明即可）。
             */
            case 'delete-rest': {
              /**
               * 撤销完全休息 —— **稳定身份核验**（G2）。
               *
               * 旧实现只按 restDate 找第一条，于是：
               *   A 页持有 old → B 页删了 old 又建了同日的 new →
               *   A 用旧快照撤销时会**成功删掉 new**（误删别页刚建的记录）。
               * 现在按 `session.id + kind + 固定 restDate` 三者核验，
               * 缺失或被替代一律返回冲突，**绝不按日期自动换一个对象删**。
               * 正常撤销只删该 rest，不碰真实训练、不回退 cursor。
               */
              const list = allSessions ?? [];
              const target = list.find((x) => x.id === session.id);
              if (
                !target ||
                (target.kind ?? 'strength') !== 'rest' ||
                target.restDate === undefined ||
                target.restDate !== intent.restDate
              ) {
                abort(
                  fail(
                    'state-conflict',
                    '这条完全休息记录已经被改动或撤销过了（可能另一个页面操作过），本页没有删除其它记录。',
                    target ?? current,
                  ),
                );
                return;
              }
              try {
                sessions.delete(target.id);
              } catch (err) {
                abort(fail('storage', err instanceof Error ? err.message : '删除失败', current));
                return;
              }
              finishWrite({ ok: true, revision: 0, session: target });
              return;
            }
            case 'create': {
              if (current) {
                abort(fail('state-conflict', '这条训练记录已存在，不能重复新建', current));
                return;
              }
              /**
               * G1：普通开练的**反向互斥**。
               *
               * 旧实现只查当前 ID，于是「先记录完全休息，再开始力量/有氧」会同时成功
               * （真实 IDB 与双页竞争均已复现），造成同一天既"完全休息"又"练了"。
               * 现在在同一事务内读全部 sessions：
               * · 同日已有 rest → 必须先明确撤销休息才能训练；
               * · 同一时刻只能有一条 active（双页竞争也在此拦住）。
               */
              const list = allSessions ?? [];
              const dayKeys = new Set<string>([
                localDateKey(session.startedAt),
                ...(session.endedAt ? [localDateKey(session.endedAt)] : []),
              ]);
              const sameDayRest = list.find(
                (x) =>
                  x.status !== 'discarded' &&
                  (x.kind ?? 'strength') === 'rest' &&
                  x.restDate !== undefined &&
                  dayKeys.has(x.restDate),
              );
              if (sameDayRest) {
                abort(
                  fail(
                    'state-conflict',
                    '今天已记录为完全休息。请先在历史里撤销这条休息记录，再开始训练。',
                    sameDayRest,
                  ),
                );
                return;
              }
              /*
                注意：这里**不**新增「同一时刻只能一条 active」的硬门禁。
                旧库可能残留多条未结束训练，首页会逐条列出让用户处理（既有设计）；
                G1 要的是「同日休息 ↔ 训练」的双向互斥，active 保护由 create-rest
                分支与首页引导负责。加硬门禁会破坏既有的孤儿处理路径。
              */
              writeNext({ ...session, revision: 1 });
              return;
            }
            case 'active-save': {
              if (!current) {
                abort(fail('state-conflict', '找不到这条训练记录，可能已被删除', current));
                return;
              }
              if (curStatus !== 'active') {
                // 审查 D14：终态不能被旧 active 快照复活
                abort(
                  fail(
                    'state-conflict',
                    curStatus === 'completed' ? '这条训练已经结束，请刷新后查看' : '这条训练已经放弃，请刷新后查看',
                    current,
                  ),
                );
                return;
              }
              if (expectedRevision !== undefined && expectedRevision !== curRev) {
                abort(fail('version-conflict', '这条记录已被更新（可能在另一个页面改过），请刷新后重新编辑', current));
                return;
              }
              writeNext({ ...session, revision: curRev + 1 });
              return;
            }
            case 'finish':
            case 'discard': {
              if (!current) {
                abort(fail('state-conflict', '找不到这条训练记录，可能已被删除', current));
                return;
              }
              if (curStatus !== 'active') {
                if (intent.kind === 'finish' && curStatus !== 'completed') {
                  abort(fail('state-conflict', '这条训练已经放弃，不能按完成结束', current));
                  return;
                }
                if (intent.kind === 'discard' && curStatus !== 'discarded') {
                  abort(fail('state-conflict', '这条训练已经完成，不能再放弃', current));
                  return;
                }
                // ④ 无条件幂等：**不写库**，因此不需要等提交，可以立即返回既有结果。
                // 注意这不会影响真实写分支的提交确认（那条路径走 finishWrite → oncomplete）。
                immediateSuccess = {
                  ok: true,
                  revision: curRev,
                  session: withDefaults(current)!,
                  alreadyTerminal: true,
                };
                // 没有排入任何写入，可以立即返回（不受提交结果影响）
                done(immediateSuccess);
                return;
              }
              if (expectedRevision !== undefined && expectedRevision !== curRev) {
                abort(
                  fail(
                    'version-conflict',
                    '这条记录已有新版本，请先确认最新修改已保存后再结束或放弃',
                    current,
                  ),
                );
                return;
              }
              // 结束/放弃都以**事务内最新记录**为数据底，只应用终态字段，
              // 避免「首页旧快照」把别页刚保存的次数覆盖回去（审查 D19）。
              const base: Session = { ...current };
              /**
               * REVIEW-2 #2：**discard 与 finish 共用同一个封口逻辑**。
               * 放弃 ≠ 清空真实内容：已做的有效有氧量与实际参数分段必须保留，
               * 只把仍在 running 的 entry 用**库内锚点 + 同一个捕获结束时刻**封口，
               * 终态后计时不再增长；也不接受调用方传入的旧候选段冒充已保存事实。
               * 终态幂等、锁、循环不推进、失败原子性都保持不变。
               */
              const terminalAt = session.endedAt ?? now;
              const sealedCardio = Array.isArray(base.cardio)
                ? base.cardio.map((c) => finalizeCardioForFinish(c, terminalAt))
                : base.cardio;
              if (intent.kind === 'discard') {
                const next: Session = {
                  ...base,
                  ...(sealedCardio ? { cardio: sealedCardio } : {}),
                  status: 'discarded',
                  endedAt: terminalAt,
                  revision: curRev + 1,
                };
                writeNext(next);
                return;
              }
              // finish：需要事务内最新计划来算游标（及可选 Wave 3A 单事务同步回原计划训练日）
              const planId = base.planId;
              const planReq = plans!.get(planId);
              planReq.onsuccess = () => {
                const curPlan = planReq.result as Plan | undefined;
                let workingPlan: Plan | undefined = curPlan;
                if (intent.syncBackToPlanDay) {
                  if (!curPlan) {
                    abort(
                      fail(
                        'state-conflict',
                        '原计划已不存在，无法将今日动作编排同步回计划（训练尚未结束，取消勾选后可正常结束）',
                        current,
                      ),
                    );
                    return;
                  }
                  const synced = applySessionArrangementToPlan(
                    curPlan,
                    base.day.dayId,
                    withDefaults(base)!,
                    terminalAt,
                  );
                  if (!synced.ok) {
                    abort(fail('state-conflict', synced.message, current));
                    return;
                  }
                  workingPlan = synced.plan;
                }
                const shouldAdvance =
                  intent.advanceCycle && !base.advancedCycle && !!workingPlan && workingPlan.days.length > 0;
                const movedPlan = shouldAdvance && workingPlan ? pushCycle(workingPlan) : undefined;
                const planToPersist =
                  movedPlan && workingPlan
                    ? { ...workingPlan, ...movedPlan }
                    : intent.syncBackToPlanDay
                      ? workingPlan
                      : undefined;
                /**
                 * 第2阶段：以**库内 current 的锚点与参数**结算有氧
                 * （不接受调用方传入的 endedAtMs/segments 作为已保存事实）。
                 * · running → 结算最后段并封口
                 * · paused  → 保留已有有效量并终结
                 * · pending → 不伪造时长
                 * 完成时刻用同一个 `session.endedAt ?? now`。
                 */
                // 与 discard 同一个捕获时刻与同一封口逻辑（见上），不重复合成
                const finalizedCardio = sealedCardio;
                const next: Session = {
                  ...base,
                  ...(finalizedCardio ? { cardio: finalizedCardio } : {}),
                  status: 'completed',
                  endedAt: terminalAt,
                  advancedCycle: Boolean(shouldAdvance),
                  // 从**事务内最新计划**读游标：不信任 UI 预先算好的 cycleIndexAfter
                  cycleIndexAfter: movedPlan ? movedPlan.cursor : (workingPlan?.cursor ?? base.cycleIndexAtStart),
                  revision: curRev + 1,
                };
                // 训练备注等文本允许由调用方提供（只有文本字段，不含实际记录）
                if (typeof session.note === 'string') next.note = session.note;
                try {
                  sessions.put(next);
                  if (planToPersist) plans!.put(planToPersist);
                } catch (err) {
                  abort(fail('storage', err instanceof Error ? err.message : '写入失败', current));
                  return;
                }
                /**
                 * V4-01：**不在这里返回成功**。
                 * put 只是把请求排进队列；提交阶段仍可能失败（审查 V4D12 注入的 abort）。
                 * 结果暂存到 pendingSuccess，由下面的 finishWrite(next, …) 统一交给 oncomplete。
                 */
                finishWrite({
                  ok: true,
                  revision: next.revision ?? 0,
                  session: next,
                  plan: planToPersist ?? workingPlan,
                });
              };
              planReq.onerror = () => abort(fail('storage', '无法读取计划，结束已取消', current));
              return;
            }
            case 'history-edit': {
              if (!current) {
                abort(fail('state-conflict', '找不到这条历史记录', current));
                return;
              }
              if (curStatus === 'active') {
                abort(fail('state-conflict', '这条训练还在进行中，不能按历史纠错保存', current));
                return;
              }
              if (expectedRevision !== undefined && expectedRevision !== curRev) {
                abort(
                  fail('version-conflict', '这条历史记录已被修改过（可能在另一个页面），你的草稿没有覆盖它，请刷新后重新编辑', current),
                );
                return;
              }
              // 历史纠错保留终态语义，只允许改实际数据与备注
              const next: Session = {
                ...session,
                status: current.status,
                endedAt: current.endedAt,
                startedAt: current.startedAt,
                revision: curRev + 1,
              };
              writeNext(next);
              return;
            }
          }
        };

        /**
         * 排入写入并登记成功结果。
         * 成功结果只登记在 pendingSuccess，**由 transaction.oncomplete 唯一确认**。
         * 锁续租 / 结束后的锁清理都与终态写在同一个事务里，一起成功或一起回滚。
         */
        const writeNext = (next: Session) => {
          // G3：写入边界统一核验有氧会话不变量（非法一律拒绝，不产生无法恢复的自产备份）
          if (next.status === 'active') {
            const violation = cardioWriteViolation(next);
            if (violation) {
              abort(fail('state-conflict', violation, current));
              return;
            }
          }
          try {
            sessions.put(next);
          } catch (err) {
            abort(fail('storage', err instanceof Error ? err.message : '写入失败', current));
            return;
          }
          /**
           * G1：可选模板记忆与 session 修改在同一事务内提交。
           * 模板 revision 冲突 → abort 整个事务（session 也不落库），
           * 绝不出现"训练存了但模板冲突"或"模板写了但训练回滚"的半状态。
           */
          if (templateWrite) {
            const row = templateRaw as { value?: unknown } | undefined;
            const currentTpl =
              row && typeof row === 'object' && typeof row.value === 'object' && row.value !== null
                ? (row.value as Record<string, unknown>)
                : undefined;
            const actualRev =
              currentTpl && typeof currentTpl.revision === 'number' ? currentTpl.revision : null;
            if (templateWrite.expectedRevision === null) {
              if (actualRev !== null) {
                abort(
                  fail(
                    'version-conflict',
                    '这条动作配置已经有记忆了（可能另一个页面刚保存过），本页没有覆盖它；训练修改也已取消，请刷新后重试',
                    current,
                  ),
                );
                return;
              }
            } else if (actualRev !== templateWrite.expectedRevision) {
              abort(
                fail(
                  'version-conflict',
                  '动作配置记忆已被更新（可能在另一个页面改过），本页没有覆盖新数据；训练修改也已取消，请刷新后重试',
                  current,
                ),
              );
              return;
            }
            const nextTemplate: ExerciseTemplate = {
              ...templateWrite.template,
              schemaVersion: 1,
              revision: templateWrite.expectedRevision === null ? 1 : templateWrite.expectedRevision + 1,
              updatedAt: Date.now(),
            };
            try {
              meta.put({ key: nextTemplate.key, value: nextTemplate });
            } catch (err) {
              abort(fail('storage', err instanceof Error ? err.message : '模板写入失败', current));
              return;
            }
            pendingTemplate = nextTemplate;
          }
          // 活动保存会顺手续租，避免长间隔后自己掉锁（与记录写同事务）
          if (intent.kind === 'active-save' && editorId) {
            /**
             * G3A2-FIX2：续租写与同函数其他写入一样必须走 storage 失败门禁。
             * 事务已结束/被 abort 时 put 会抛 TransactionInactiveError，
             * 旧实现不 catch → 未捕获异常（真实 abort 注入用例的 pageerror）。
             * 这里只把失败转成既有 fail('storage') → abort，不吞成功、
             * 不改 CAS/锁资格/事务原子性。
             */
            try {
              meta.put({ key: lockKey(session.id), sessionId: session.id, editorId, at: Date.now() });
            } catch (err) {
              abort(fail('storage', err instanceof Error ? err.message : '续租写入失败', current));
              return;
            }
          }
          finishWrite({ ok: true, revision: next.revision ?? 0, session: next });
        };

        /**
         * finish 分支也走这里：plan 是额外要返回的信息，同样只在提交后可见。
         */
        const finishWrite = (result: WriteResult) => {
          // 锁清理与终态同事务（finish/discard 都释放锁，一起提交或一起回滚）
          if (intent.kind === 'finish' || intent.kind === 'discard') {
            try {
              meta.put({ key: lockKey(session.id), sessionId: session.id, editorId: '', at: 0 });
            } catch (err) {
              // 同上：锁清理写失败也必须走 storage 门禁，不能抛成未捕获异常
              abort(fail('storage', err instanceof Error ? err.message : '释放锁写入失败', current));
              return;
            }
          }
          // G6：所有成功出口的 session 也补内存缺省（读时归一，不写库）
          pendingSuccess =
            'session' in result && result.session
              ? {
                  ...result,
                  session: withDefaults(result.session)!,
                  ...(pendingTemplate ? { template: pendingTemplate } : {}),
                }
              : result;
        };

        lockReq.onsuccess = () => {
          lockRaw = lockReq.result;
          step();
        };
        lockReq.onerror = () => abort(fail('storage', '无法读取编辑锁'));
        curReq.onsuccess = () => {
          current = curReq.result as Session | undefined;
          step();
        };
        curReq.onerror = () => abort(fail('storage', '无法读取训练记录'));
      }),
  );
}

/* ── 兼容包装（保留既有调用点与测试的语义）────────── */

/** 带锁校验的普通保存（训练进行中每次改动） */
export function atomicSaveSession(args: {
  session: Session;
  guard: { sessionId?: string; editorId: string; ttlMs?: number; expectedVersion?: number | null };
}): Promise<WriteResult> {
  const { session, guard } = args;
  return atomicWriteSession({
    intent: { kind: 'active-save' },
    session,
    editorId: guard.editorId,
    expectedRevision: typeof guard.expectedVersion === 'number' ? guard.expectedVersion : undefined,
    ttlMs: guard.ttlMs,
  });
}

/**
 * G1：活动保存 + 可选模板记忆，同一锁/事务/revision 约束。
 * 模板 expectedRevision 冲突会 abort 整个事务（session 修改也回滚）。
 */
export function atomicSaveSessionWithTemplate(args: {
  session: Session;
  guard: { sessionId?: string; editorId: string; ttlMs?: number; expectedVersion?: number | null };
  template: ExerciseTemplate;
  /** null = 首次创建必须不存在；number = 必须等于现有 revision */
  templateExpectedRevision: number | null;
}): Promise<WriteResult> {
  const { session, guard, template, templateExpectedRevision } = args;
  return atomicWriteSession({
    intent: { kind: 'active-save' },
    session,
    editorId: guard.editorId,
    expectedRevision: typeof guard.expectedVersion === 'number' ? guard.expectedVersion : undefined,
    ttlMs: guard.ttlMs,
    templateWrite: { template, expectedRevision: templateExpectedRevision },
  });
}

/**
 * 结束训练（原子写终态 + 按需推进计划）。
 * · 不传 expectedVersion：以事务内最新记录为准（幂等、不推进第二次）。
 * · 传 expectedVersion：额外做一次版本核验。
 * · plan 参数已废弃：推进由事务内最新计划计算；保留了入参以便旧调用不报错。
 */
export function atomicFinishSession(args: {
  session: Session;
  plan?: Plan;
  guard?: {
    sessionId?: string;
    editorId?: string;
    ttlMs?: number;
    expectedVersion?: number | null;
    /** 结束时是否推进循环；不传则读 session.advancedCycle 的意图 */
    advanceCycle?: boolean;
    /** Wave 3A：同一事务内是否把今日动作编排写回原计划训练日（默认 false） */
    syncBackToPlanDay?: boolean;
    lockPolicy?: 'required' | 'optional';
  };
}): Promise<WriteResult> {
  const { session, guard } = args;
  const advanceCycle = guard?.advanceCycle ?? session.advancedCycle ?? false;
  return atomicWriteSession({
    intent: {
      kind: 'finish',
      advanceCycle,
      ...(guard?.syncBackToPlanDay ? { syncBackToPlanDay: true } : {}),
    },
    session,
    editorId: guard?.editorId,
    expectedRevision: typeof guard?.expectedVersion === 'number' ? guard.expectedVersion : undefined,
    ttlMs: guard?.ttlMs,
    lockPolicy: guard?.lockPolicy ?? 'required',
  });
}

/** 放弃训练（原子写终态，不推进） */
export function atomicDiscardSession(args: {
  session: Session;
  guard?: { editorId?: string; ttlMs?: number; expectedVersion?: number | null; lockPolicy?: 'required' | 'optional' };
}): Promise<WriteResult> {
  const { session, guard } = args;
  return atomicWriteSession({
    intent: { kind: 'discard' },
    session,
    editorId: guard?.editorId,
    expectedRevision: typeof guard?.expectedVersion === 'number' ? guard.expectedVersion : undefined,
    ttlMs: guard?.ttlMs,
    lockPolicy: guard?.lockPolicy ?? 'required',
  });
}

/** 新建训练（不允许覆盖已存在记录） */
export function atomicCreateSession(args: {
  session: Session;
  guard?: { editorId?: string; lockPolicy?: 'required' | 'optional' };
}): Promise<WriteResult> {
  const { session, guard } = args;
  return atomicWriteSession({
    intent: { kind: 'create' },
    session,
    editorId: guard?.editorId,
    lockPolicy: guard?.lockPolicy ?? 'optional',
  });
}

/** 历史纠错保存（必须带 expectedRevision；不改终态） */
export function atomicSaveHistoryEdit(args: {
  session: Session;
  expectedRevision: number;
}): Promise<WriteResult> {
  return atomicWriteSession({
    intent: { kind: 'history-edit' },
    session: args.session,
    expectedRevision: args.expectedRevision,
    lockPolicy: 'optional',
  });
}

/* ── 锁操作转发（保持既有的 import 路径可用）────────── */

export { atomicAcquireOrRenew, atomicRenew, atomicRelease, readLockState };

/** 原子获取/续租锁（读与写在同一事务里，避免两个标签同时 ok=true） */
export async function atomicAcquireLock(
  sessionId: string,
  editorId: string,
  ttlMs = DEFAULT_LOCK_TTL_MS,
): Promise<{ ok: true } | { ok: false; heldBy: string }> {
  const r = await atomicAcquireOrRenew(sessionId, editorId, ttlMs);
  return r.ok ? { ok: true } : { ok: false, heldBy: r.heldBy ?? 'unknown' };
}

/** 供 UI 直接拿到带 reason 的锁结果 */
export async function acquireLockDetailed(
  sessionId: string,
  editorId: string,
  ttlMs = DEFAULT_LOCK_TTL_MS,
): Promise<LockOpResult> {
  return atomicAcquireOrRenew(sessionId, editorId, ttlMs);
}

export { StorageError };


/* ── 第2阶段：有氧 / 完全休息的受约束入口 ─────────── */

/**
 * 记录完全休息（原子）。
 *
 * 在**同一事务**内完成：同日去重（跨计划）→ 与 active/实际训练互斥 →
 * 读最新 plan → 按 `advanceCycle` 推进一次 → 写入 rest（创建即 completed）。
 */
export function atomicCreateRest(args: {
  session: Session;
  restDate: string;
  advanceCycle: boolean;
  guard?: { editorId?: string; ttlMs?: number };
}): Promise<WriteResult> {
  return atomicWriteSession({
    intent: { kind: 'create-rest', restDate: args.restDate, advanceCycle: args.advanceCycle },
    session: args.session,
    editorId: args.guard?.editorId,
    ttlMs: args.guard?.ttlMs,
    lockPolicy: 'optional',
  });
}

/** 撤销完全休息（只删该 rest 记录，不碰真实训练、不回退 cursor） */
export function atomicDeleteRest(args: {
  session: Session;
  restDate: string;
  guard?: { editorId?: string; ttlMs?: number };
}): Promise<WriteResult> {
  return atomicWriteSession({
    intent: { kind: 'delete-rest', restDate: args.restDate },
    session: args.session,
    editorId: args.guard?.editorId,
    ttlMs: args.guard?.ttlMs,
    lockPolicy: 'optional',
  });
}

/* ── 第3阶段：计划模板导入的受约束入口 ─────────── */

/**
 * **insert-only** 新增计划（模板导入唯一写入路径）。
 *
 * 为什么不能走 savePlan/upsertPlan：`idbPut` 对已存在 id 会**整份覆盖**。
 * 模板导入承诺"只新增、绝不覆盖旧数据"，所以必须：
 * · 同一事务内读 plans 全集；
 * · id 已存在 → 拒绝（不覆盖，哪怕调用方声称是新计划）；
 * · 数量达 MAX_PLANS → 拒绝（与编辑器同一条容量真源）；
 * · 名称与已有计划相同 → 默认拒绝并给出可明确改写的开关（重复确认门禁），
 *   仍只新增独立记录，**不按名称合并/替换**；
 * · 通过核验才 `add`（不是 put）：IDB add 对已有 key 会抛 ConstraintError，
 *   是整个事务的兜底防线；
 * · 事务 abort / 任一路径失败 → 整体回滚，不留半份。
 * 不触碰 active session、历史、设置。
 */
export type InsertPlanResult =
  | { ok: true; plan: Plan }
  | { ok: false; reason: 'duplicate-name' | 'duplicate-id' | 'capacity' | 'storage'; message: string };

export function atomicInsertPlan(plan: Plan, opts: { allowDuplicateName?: boolean } = {}): Promise<InsertPlanResult> {
  return openDb().then(
    (db) =>
      new Promise<InsertPlanResult>((resolve) => {
        let settled = false;
        const done = (r: InsertPlanResult) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        let t: IDBTransaction;
        try {
          t = db.transaction(['plans'], 'readwrite');
        } catch (err) {
          done({ ok: false, reason: 'storage', message: err instanceof Error ? err.message : '事务开启失败' });
          return;
        }
        const store = t.objectStore('plans');
        let pending: Plan | null = null;

        const allReq = store.getAll();
        allReq.onerror = () => {
          done({ ok: false, reason: 'storage', message: allReq.error?.message ?? '读取计划列表失败' });
        };
        allReq.onsuccess = () => {
          const existing = (allReq.result ?? []) as Plan[];
          // id 冲突 → 拒绝（绝不覆盖）
          if (existing.some((p) => p.id === plan.id)) {
            t.abort();
            done({
              ok: false,
              reason: 'duplicate-id',
              message: '这条计划的内部 ID 与已有计划撞上了，已停止导入（不会覆盖任何旧计划）。请重新发起一次导入。',
            });
            return;
          }
          // 容量：与编辑器/备份校验同一真源，同事务核验（并发下由 add 兜底）
          if (existing.length >= MAX_PLANS) {
            t.abort();
            done({
              ok: false,
              reason: 'capacity',
              message: `最多保留 ${MAX_PLANS} 个计划，当前已有 ${existing.length} 个。请先删除不用的计划再导入。`,
            });
            return;
          }
          // 同名默认拒绝（重复确认门禁：用户明确确认后才允许同名并存）
          const name = plan.name.trim();
          const sameName = existing.filter((p) => p.name.trim() === name);
          if (sameName.length > 0 && !opts.allowDuplicateName) {
            t.abort();
            done({
              ok: false,
              reason: 'duplicate-name',
              message: `已经有一个同名计划「${name}」。导入不会合并或覆盖它；如果确定要再来一份，请勾选「确认新增同名计划」再提交。`,
            });
            return;
          }
          try {
            // add（不是 put）：对已有 key 抛 ConstraintError → 事务失败，双保险
            store.add(plan);
            pending = plan;
          } catch (err) {
            t.abort();
            done({ ok: false, reason: 'storage', message: err instanceof Error ? err.message : '写入失败' });
          }
        };

        t.oncomplete = () => {
          if (pending) done({ ok: true, plan: pending });
          else done({ ok: false, reason: 'storage', message: '事务完成但没有写入，已按失败处理' });
        };
        t.onabort = () => {
          done({
            ok: false,
            reason: 'storage',
            message: t.error?.message ?? '导入被中止，未写入任何内容（既有计划与历史都不受影响）',
          });
        };
        t.onerror = () => {
          done({ ok: false, reason: 'storage', message: t.error?.message ?? '写入失败' });
        };
      }),
  );
}
