/* 未保存草稿的重试合并（V5-01）。
   ── 问题背景（审查 V5D09）────────────────────────────────────
   本页在只读状态下保留了一份「整份旧 session 快照」作为待存草稿。
   另一页随后保存了别处（例如第 2 组 20 次）并释放锁。
   本页回到前台、取得锁、点「重试保存这次改动」，旧实现做了这件事：

       persist({ ...pending, revision: freshRevision })

   即**给整份旧快照换上最新 revision**，骗过存储层的 CAS，把另一页刚保存的
   第 2 组 20 次整段覆盖成 null。这不是存储层没做冲突保护，
   而是 UI 自己绕开了它。

   ── 本轮原则 ────────────────────────────────────────────────
   1. 草稿永远带着自己的 `baseRevision`（它生成时基于的库版本），
      **不因为重新取得锁就改成 fresh revision**。
   2. baseRevision 与 fresh revision 相同 → 没有别人动过，可整份直接保存。
   3. 不同 → 只把**本页实际修改过**的字段，按稳定 set / exercise ID 应用到 fresh 上；
      别人改的其他字段原样保留。
   4. 同一字段两边都改了且值不同 → **冲突**，拒绝整次重试（不默认选本页旧值）。
   5. 结构变化（组/轮增删、target、动作集合）一律视为冲突并拒绝 ——
      本轮不做结构合并，避免"用旧整动作替换新库"。
   6. 无论哪种结果，草稿都不在这里被丢弃；调用方负责保留。

   这个模块是纯函数：不读库、不读 React 状态，便于穷举测试。 */

import type { CardioEntry, Session, SessionExercise, SessionSet } from './types';

/** 草稿在内存里的形态：永远配对自己的基数版本 */
export interface PendingDraft {
  /**
   * 草稿身份（V6-01）。
   * 为什么需要：普通保存成功曾经无条件清空 pending，
   * 把"不包含在这次提交里"的另一份意图一起抹掉。
   * 有了 token，只有真正把这份草稿提交成功（或用户明确放弃）才允许清除。
   */
  token: number;
  /** 用户想要的最终状态（整份快照，仅作为"意图"载体） */
  session: Session;
  /** 用户开始这批修改时，本页已确认落库的版本 */
  baseRevision: number;
  /** 生成草稿时库里的样子（3-way 合并的 base 一侧） */
  baseSession: Session;
  /**
   * 本页上一次**实际成功提交**的那一版（D1/C）及其 revision（A06 F1/F2）。
   *
   * 语义（审查给定的精确边界）：
   *   设 D1 = 本次提交的原始意图快照（**不带**别处后来写入的内容）
   *      C  = D1 真正提交后库里的结果（它可能包含别处写入的 20）
   *      D2 = 晚到的更新意图（在 D1 之上继续演进，本身不含 20）
   *
   * 正确做法是把 base 取 D1（不是 C）：先 base=D1 / mine=D2 / fresh=C 合并出 M2，
   * 再把新 pending 配成 base=C(revC) / target=M2。
   * 若直接把 base 换成 C，D2 里没有 20 就会被误判成“本页主动删掉了 20”。
   *
   * 因此这里只存 **D1**（提交时的原始意图）与它落库后的 revision（用于判定
   * 「现在库里的这一版就是我写的」），**绝不**把它当作合并基准去比较字段。
   */
  priorOwnCommit?: { revision: number; intent: Session };
}

/** 一次保存尝试的真实结果（V6-02）：入队 ≠ 已保存 */
export type PersistOutcome =
  | { status: 'saved'; revision: number; includedDraft: boolean }
  | { status: 'failed'; reason: string; message: string }
  | { status: 'not-attempted' };

export interface MergeConflict {
  /** 冲突位置，便于 UI 精确指出 */
  path: string;
  /** 人类可读说明 */
  message: string;
  /** 本页的值 */
  mine: unknown;
  /** 库里的值 */
  theirs: unknown;
}

export type MergeOutcome =
  | { ok: true; session: Session; appliedFields: string[] }
  | { ok: false; conflicts: MergeConflict[]; message: string };

/** 读一条会话的 revision（缺省视为 0），与 db/tx.ts 的 revisionOf 保持同一语义 */
function revisionOfSession(s: Session): number {
  const r = (s as { revision?: number }).revision;
  return typeof r === 'number' && Number.isFinite(r) ? r : 0;
}

/** 参与三方比较的 set 字段。结构字段（id/roundIndex/stageIndex）不在此列。 */
const SET_FIELDS = ['reps', 'weightKg', 'status', 'toFailure', 'note'] as const;
type SetField = (typeof SET_FIELDS)[number];

const same = (a: unknown, b: unknown): boolean => {
  // 区分 null 与 0、false 与 undefined 的语义（0 是实际值，null 是未填）
  if (a === b) return true;
  if (a === null && b === undefined) return true;
  if (a === undefined && b === null) return true;
  return false;
};

const setById = (sets: SessionSet[] | undefined, id: string): SessionSet | undefined =>
  (sets ?? []).find((s) => s.id === id);

const exById = (list: SessionExercise[] | undefined, id: string): SessionExercise | undefined =>
  (list ?? []).find((e) => e.id === id);

/** 结构指纹：只在"是否发生结构变化"的判断里用，不参与字段合并 */
function structureKey(ex: SessionExercise): string {
  return JSON.stringify({
    target: ex.target,
    groups: (ex.groups ?? []).map((g) => [g.index, g.stageCount, Boolean(g.skipped)]),
    setIds: ex.sets.map((s) => s.id),
    setIdRounds: ex.sets.map((s) => [s.id, s.roundIndex, s.stageIndex]),
  });
}

function exerciseIds(s: Session): string[] {
  return s.exercises.map((e) => e.id);
}

/**
 * 三方合并：把草稿里「本页实际改过」的字段应用到 fresh 上。
 *
 * @param base   草稿生成时库里的样子
 * @param mine   用户想要的最终状态
 * @param fresh  现在库里的最新状态
 */
export function mergeDraftOntoFresh(
  base: Session,
  mine: Session,
  fresh: Session,
  /**
   * A06：本页上一次提交的**原始意图快照 D1** 与它落库后的 revision。
   * `fresh.revision === priorOwnCommit.revision` 时说明库现在就是我写的，
   * 此时用 D1 作 base 合并「同一意图的后续增量」，避免把别处写入的字段当成删除。
   */
  priorOwnCommit?: { revision: number; intent: Session } | null,
): MergeOutcome {
  /**
   * 只有「库当前就是我上一次提交的结果」时才走同意图演进路径。
   *
   * 注意这里替换的 base 是 **D1（提交时的原始意图）**，不是库里的 C：
   *   base=D1 / mine=D2 / fresh=C
   * → D2 相对 D1 真正改了哪些字段；D2 里没有、但 C 里有的（别处写入的 20）
   *   因为 `mine` 与 `base` 都没变 → 采用 fresh 的值，**不会被当成删除**。
   * 若错误地用 C 当 base，D2 缺 20 就会被判成“本页删掉了 20”。
   */
  const sameOwner = priorOwnCommit && revisionOfSession(fresh) === priorOwnCommit.revision;
  const effBase: Session = sameOwner ? priorOwnCommit.intent : base;
  const conflicts: MergeConflict[] = [];
  const applied: string[] = [];

  /* ── 0. 会话级字段：只有 note / pausedMs / pausedAt 允许三方合并 ── */
  // 终态/时间戳/planId 等不允许被草稿改动，一律以 fresh 为准。
  const next: Session = { ...fresh };

  const mergeScalar = <K extends 'note' | 'pausedMs' | 'pausedAt'>(
    key: K,
    path: string,
  ): void => {
    const b = effBase[key];
    const m = mine[key];
    const f = fresh[key];
    if (same(m, b)) return; // 本页没改这一项：用 fresh
    // 本页改了 → 看别人是否也改了
    if (!same(f, b) && !same(f, m)) {
      conflicts.push({
        path,
        message: `${path} 两边都改过了`,
        mine: m,
        theirs: f,
      });
      return;
    }
    (next as unknown as Record<string, unknown>)[key] = m;
    applied.push(path);
  };
  mergeScalar('note', '训练备注');
  mergeScalar('pausedMs', '暂停时长');
  mergeScalar('pausedAt', '暂停时间');

  /* ── 0b. 有氧（第2阶段）：以 **entry 为最小一致单元** 三方合并 ──
     段会被封口、继续、修改结束边界，因此不能"只增不覆盖"。
     规则（PHASE-2-DECISIONS §3）：
       · entry 按稳定 id 合并；
       · 一边改力量、一边改有氧 → 保留双方；
       · 同一 entry 双方都相对 base 改动且结果不同 → 明确冲突
         （不把两条独立计时分支拼成假的连续运动）；
       · 不同 entry 的非冲突变更合并后仍校验会话级不变量（最多一个 running）。 */
  const baseCardio = effBase.cardio ?? [];
  const mineCardio = mine.cardio ?? [];
  const freshCardio = fresh.cardio ?? [];
  const cardioTouched =
    JSON.stringify(mineCardio) !== JSON.stringify(baseCardio) ||
    JSON.stringify(freshCardio) !== JSON.stringify(baseCardio);
  if (cardioTouched) {
    const merged = mergeCardioEntries({
      base: baseCardio,
      mine: mineCardio,
      fresh: freshCardio,
      conflicts,
    });
    if (merged) {
      next.cardio = merged;
      // 合并后仍须满足会话级不变量
      if (merged.filter((c) => c.status === 'running').length > 1) {
        conflicts.push({
          path: '有氧计时',
          message: '合并后出现多个正在运行的有氧项目，已拒绝自动合并',
          mine: mineCardio.length,
          theirs: freshCardio.length,
        });
        return { ok: false, conflicts, message: summarize(conflicts) };
      }
      applied.push('有氧');
    }
  }

  /**
   * G4b：暂停来源 cardioPausedBySession 是**会话级字段**，必须独立于有氧列表
   * 是否变动都做三方合并 —— 否则「两边只改暂停来源、有氧 entry 内容相同」时
   * cardioTouched=false，这段会被整体跳过，fresh（空）覆盖 mine 的暂停来源，
   * resume 无法恢复（真实草稿合并缺口）。
   */
  const basePaused = effBase.cardioPausedBySession ?? [];
  const minePaused = mine.cardioPausedBySession ?? [];
  const freshPaused = fresh.cardioPausedBySession ?? [];
  const pausedSame = (a: string[], b: string[]): boolean =>
    JSON.stringify(a) === JSON.stringify(b);
  const pausedMineChanged = !pausedSame(minePaused, basePaused);
  const pausedFreshChanged = !pausedSame(freshPaused, basePaused);
  if (pausedMineChanged && pausedFreshChanged && !pausedSame(minePaused, freshPaused)) {
    conflicts.push({
      path: '暂停来源',
      message: '两边都改过"因整次暂停而停住的有氧"列表，无法自动合并',
      mine: minePaused,
      theirs: freshPaused,
    });
    return { ok: false, conflicts, message: summarize(conflicts) };
  }
  if (pausedMineChanged || pausedFreshChanged) {
    next.cardioPausedBySession = pausedMineChanged ? minePaused : freshPaused;
    applied.push('暂停来源');
  } else {
    next.cardioPausedBySession = freshPaused;
  }

  /* ── 1. 动作集合必须一致：增删动作属于结构变化 → 冲突 ── */
  const baseIds = exerciseIds(effBase);
  const mineIds = exerciseIds(mine);
  const freshIds = exerciseIds(fresh);

  if (JSON.stringify(mineIds) !== JSON.stringify(baseIds)) {
    conflicts.push({
      path: '动作列表',
      message: '本页改过动作集合（增删/排序），这类结构变化不能自动合并',
      mine: mineIds,
      theirs: freshIds,
    });
    return { ok: false, conflicts, message: summarize(conflicts) };
  }
  if (JSON.stringify(freshIds) !== JSON.stringify(baseIds)) {
    conflicts.push({
      path: '动作列表',
      message: '另一个页面改过动作集合（增删/排序），本页草稿不能整份覆盖',
      mine: mineIds,
      theirs: freshIds,
    });
    return { ok: false, conflicts, message: summarize(conflicts) };
  }

  /* ── 2. 逐动作 ── */
  next.exercises = fresh.exercises.map((freshEx) => {
    const baseEx = exById(effBase.exercises, freshEx.id)!;
    const mineEx = exById(mine.exercises, freshEx.id)!;

    // 结构必须一致，否则不合并（不用旧整动作替换新库）
    const mineChangedStructure = structureKey(mineEx) !== structureKey(baseEx);
    const freshChangedStructure = structureKey(freshEx) !== structureKey(baseEx);
    if (mineChangedStructure || freshChangedStructure) {
      conflicts.push({
        path: `动作「${freshEx.name}」的组结构`,
        message: mineChangedStructure
          ? '本页改过这个动作的组结构（增删组/轮或目标），结构变化不能自动合并'
          : '另一个页面改过这个动作的组结构，本页草稿不能整份覆盖',
        mine: mineChangedStructure ? structureKey(mineEx) : null,
        theirs: freshChangedStructure ? structureKey(freshEx) : null,
      });
      return freshEx;
    }

    const mergedEx: SessionExercise = { ...freshEx };

    // 动作级 note / status：三方合并
    for (const key of ['note', 'status'] as const) {
      const b = baseEx[key];
      const m = mineEx[key];
      const f = freshEx[key];
      if (same(m, b)) continue;
      if (!same(f, b) && !same(f, m)) {
        conflicts.push({
          path: `动作「${freshEx.name}」的${key === 'note' ? '备注' : '完成状态'}`,
          message: '两边都改过了',
          mine: m,
          theirs: f,
        });
        continue;
      }
      (mergedEx as unknown as Record<string, unknown>)[key] = m;
      applied.push(`${freshEx.id}.${key}`);
    }

    // 组记录行：按稳定 set id 逐字段三方合并
    mergedEx.sets = freshEx.sets.map((freshSet) => {
      const baseSet = setById(baseEx.sets, freshSet.id);
      const mineSet = setById(mineEx.sets, freshSet.id);
      if (!baseSet || !mineSet) return freshSet; // 结构已在校验里保证一致

      const mergedSet: SessionSet = { ...freshSet };
      for (const field of SET_FIELDS) {
        const b = baseSet[field];
        const m = mineSet[field] as SetField extends never ? never : unknown;
        const f = freshSet[field];
        if (same(m, b)) continue; // 本页没改
        if (!same(f, b) && !same(f, m)) {
          conflicts.push({
            path: `动作「${freshEx.name}」组 R${freshSet.roundIndex}S${freshSet.stageIndex} 的${fieldLabel(field)}`,
            message: '两边都改成了不同的值',
            mine: m,
            theirs: f,
          });
          continue;
        }
        (mergedSet as unknown as Record<string, unknown>)[field] = m;
        applied.push(`${freshEx.id}.${freshSet.id}.${field}`);
      }
      return mergedSet;
    });

    return mergedEx;
  });

  /* ── 3. 热身：按稳定 id 三方合并 done ── */
  if (mine.warmups.length !== effBase.warmups.length || fresh.warmups.length !== effBase.warmups.length) {
    conflicts.push({
      path: '热身列表',
      message: '热身项的数量在各版本间不一致，不能自动合并',
      mine: mine.warmups.length,
      theirs: fresh.warmups.length,
    });
  } else {
    next.warmups = fresh.warmups.map((fw) => {
      const bw = effBase.warmups.find((w) => w.id === fw.id);
      const mw = mine.warmups.find((w) => w.id === fw.id);
      if (!bw || !mw) return fw;
      if (same(mw.done, bw.done)) return fw;
      if (!same(fw.done, bw.done) && !same(fw.done, mw.done)) {
        conflicts.push({
          path: `热身「${fw.name}」是否完成`,
          message: '两边都改过了',
          mine: mw.done,
          theirs: fw.done,
        });
        return fw;
      }
      applied.push(`warmup.${fw.id}.done`);
      return { ...fw, done: mw.done };
    });
  }

  if (conflicts.length) {
    return { ok: false, conflicts, message: summarize(conflicts) };
  }

  // 合并结果必须基于 fresh 的 revision，由调用方在保存时显式传入
  next.revision = fresh.revision;
  return { ok: true, session: next, appliedFields: applied };
}

function fieldLabel(f: SetField): string {
  switch (f) {
    case 'reps':
      return '次数';
    case 'weightKg':
      return '重量';
    case 'status':
      return '完成状态';
    case 'toFailure':
      return '力竭标记';
    case 'note':
      return '备注';
  }
}

function summarize(conflicts: MergeConflict[]): string {
  const head = conflicts[0];
  const more = conflicts.length > 1 ? `（共 ${conflicts.length} 处）` : '';
  return `另一页也改过这段数据，本页草稿没有覆盖它：${head.path} — ${head.message}${more}。草稿仍保留在本页。`;
}


/**
 * 把「新的本地意图」叠加到「已有待存草稿」上（V6-01 路径 B）。
 *
 * 为什么不能直接用 mergeDraftOntoFresh：
 * 那个函数是**三方**场合（base=库旧值, mine=本页, fresh=别人已提交）。
 * 而这里两边都是**同一个用户尚未提交的本地意图**，没有"别人"，
 * 若把旧草稿当成 fresh 一侧，同一组从 1 改成 15 会被判成"两边都改了"冲突，
 * 结果回退成 1 —— 这正是只读时连按 `1`→`15` 最后只剩 1 的原因。
 *
 * 累积规则（后写覆盖先写，但不丢旧意图）：
 *   · 相对「当前视图」被改动过的字段 → 属于本次新意图，采用 next 的值
 *   · 没被本次改动的字段 → 若旧草稿在此处有意图（不同于它的基线），保留旧意图
 *   · 其余情况采用 next（它携带最新的库内容）
 *
 * @param oldBase   旧草稿生成时的库内容
 * @param oldDraft  旧草稿的意图快照
 * @param viewBefore 本次编辑前的当前视图（用于判断"本次改了哪些字段"）
 * @param next      本次编辑后的完整快照
 */
export function accumulateDraftIntent(
  oldBase: Session,
  oldDraft: Session,
  viewBefore: Session,
  next: Session,
): Session {
  // 结构不一致时不做字段级累积：直接用 next（调用方会保留旧草稿并提示）
  if (
    exerciseIds(oldBase).join('|') !== exerciseIds(oldDraft).join('|') ||
    exerciseIds(oldDraft).join('|') !== exerciseIds(viewBefore).join('|') ||
    exerciseIds(viewBefore).join('|') !== exerciseIds(next).join('|')
  ) {
    return next;
  }

  const result: Session = { ...next };
  result.exercises = next.exercises.map((nextEx) => {
    const baseEx = exById(oldBase.exercises, nextEx.id);
    const draftEx = exById(oldDraft.exercises, nextEx.id);
    const viewEx = exById(viewBefore.exercises, nextEx.id);
    if (!baseEx || !draftEx || !viewEx) return nextEx;

    const mergedEx: SessionExercise = { ...nextEx };
    // 动作级备注
    if (same(nextEx.note, viewEx.note) && !same(draftEx.note, baseEx.note)) {
      mergedEx.note = draftEx.note;
    }

    mergedEx.sets = nextEx.sets.map((nextSet) => {
      const baseSet = setById(baseEx.sets, nextSet.id);
      const draftSet = setById(draftEx.sets, nextSet.id);
      const viewSet = setById(viewEx.sets, nextSet.id);
      if (!baseSet || !draftSet || !viewSet) return nextSet;

      const mergedSet: SessionSet = { ...nextSet };
      for (const field of SET_FIELDS) {
        const changedNow = !same(nextSet[field], viewSet[field]);
        if (changedNow) continue; // 本次新意图：保留 next 的值
        // 本次没动这个字段：若旧草稿在这里有未提交意图，继续保留
        if (!same(draftSet[field], baseSet[field])) {
          (mergedSet as unknown as Record<string, unknown>)[field] = draftSet[field];
        }
      }
      return mergedSet;
    });
    return mergedEx;
  });

  // 会话备注同理
  if (same(next.note, viewBefore.note) && !same(oldDraft.note, oldBase.note)) {
    result.note = oldDraft.note;
  }

  /**
   * G4a：有氧**按 entry 整体**累积早先的未存意图。
   *
   * 旧实现 result 直接用 next，于是「坡度改到 8」的未存意图会在
   * 随后一次力量输入（坡度那条没动）后被 next（库里仍是 4）覆盖丢失。
   * 规则与其它字段一致：本次没动 + 旧草稿在此有意图 → 保留旧意图；
   * 且**整 entry 取舍，不逐标量拼**（避免 status/anchor/segments 混出假时间线）。
   */
  result.cardio = accumulateCardio(oldBase, oldDraft, viewBefore, next);

  /** 会话暂停来源同样按"本次没动就保留旧意图"处理 */
  if (
    same(next.cardioPausedBySession ?? [], viewBefore.cardioPausedBySession ?? []) &&
    !same(oldDraft.cardioPausedBySession ?? [], oldBase.cardioPausedBySession ?? [])
  ) {
    result.cardioPausedBySession = oldDraft.cardioPausedBySession ?? [];
  }
  return result;
}

/**
 * 有氧 entry 级累积：整 entry 取舍，不逐标量拼。
 *
 * @returns 合并后的 cardio 列表（保留旧草稿的未存意图，同时带上本次新意图）
 */
export function accumulateCardio(
  oldBase: Session,
  oldDraft: Session,
  viewBefore: Session,
  next: Session,
): CardioEntry[] {
  const base = oldBase.cardio ?? [];
  const draft = oldDraft.cardio ?? [];
  const view = viewBefore.cardio ?? [];
  const nx = next.cardio ?? [];

  // 有氧结构本次是否被改动（增删/换 id）：改了就以 next 为准
  const viewStruct = view.map((c) => c.id).join('|');
  const nextStruct = nx.map((c) => c.id).join('|');
  if (viewStruct !== nextStruct) return nx;

  const byId = (list: CardioEntry[], id: string) => list.find((c) => c.id === id);
  return nx.map((n) => {
    const v = byId(view, n.id);
    const d = byId(draft, n.id);
    const b = byId(base, n.id);
    if (!v || !d || !b) return n;
    const changedNow = !same(n, v);
    if (changedNow) return n; // 本次新意图优先
    if (!same(d, b)) return d; // 旧草稿未存意图保留
    return n;
  });
}


/**
 * 有氧 entry 的三方合并（第2阶段）。
 *
 * 返回 null 表示已记录冲突（调用方应整体拒绝）。
 * 合并粒度 = 单个 entry：整个 entry 深比较，不做逐标量拼接
 * （避免 status/anchor/params/segments 拼出不一致的混合状态）。
 */
export function mergeCardioEntries(args: {
  base: CardioEntry[];
  mine: CardioEntry[];
  fresh: CardioEntry[];
  conflicts: MergeConflict[];
}): CardioEntry[] | null {
  const { base, mine, fresh, conflicts } = args;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const list of [base, mine, fresh]) {
    for (const e of list) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        ids.push(e.id);
      }
    }
  }

  const out: CardioEntry[] = [];
  for (const id of ids) {
    const b = base.find((e) => e.id === id);
    const m = mine.find((e) => e.id === id);
    const f = fresh.find((e) => e.id === id);
    const bj = b ? JSON.stringify(b) : null;
    const mj = m ? JSON.stringify(m) : null;
    const fj = f ? JSON.stringify(f) : null;

    // 本页没改 → 用 fresh（可能是别处新增/修改，也可能是删除）
    if (mj === bj) {
      if (f) out.push(f);
      continue;
    }
    // 本页删了
    if (m === undefined) {
      if (fj !== bj) {
        conflicts.push({
          path: '有氧项目',
          message: '本页删除了一个有氧项目，但另一个页面同时改过它',
          mine: null,
          theirs: f ?? null,
        });
        return null;
      }
      continue;
    }
    // 本页新增（base 没有）
    if (b === undefined) {
      if (f !== undefined && fj !== bj) {
        conflicts.push({
          path: '有氧项目',
          message: '两边各自新增了同 id 的有氧项目且内容不同',
          mine: m,
          theirs: f,
        });
        return null;
      }
      out.push(m);
      continue;
    }
    // 本页改了，看别人
    if (fj === bj) {
      out.push(m);
      continue;
    }
    if (fj === mj) {
      out.push(m);
      continue;
    }
    // 两边都改了且结果不同 → 冲突
    conflicts.push({
      path: `有氧「${m.name}」`,
      message: '这个有氧项目两边都改过且结果不同，不能自动合并',
      mine: m,
      theirs: f,
    });
    return null;
  }
  return out;
}
