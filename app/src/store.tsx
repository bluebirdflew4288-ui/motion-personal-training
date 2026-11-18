/* 应用状态：设置 / 计划列表 / 当前激活训练。

   V3-01 关键约束（独立审查 D20）：
   · **成功的写事务之后只更新内存**，绝不再落一次库。
     旧实现在 Session.persist 的守锁保存成功后又调 updateSession → repo.saveSession，
     中间若发生合法接管，旧写者能通过第二次无锁写覆盖新数据。
   · 所有训练记录写入都经 store 暴露的受约束入口（tx.ts 的 atomicWriteSession），
     每个入口带明确的 intent（新建 / 活动保存 / 结束 / 放弃 / 历史纠错）。
   · 写失败不更新内存，并把准确原因抛给调用方显示。 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  atomicSavePlanWithTemplate,
  DEFAULT_SETTINGS,
  ensureSeed,
  listPlans,
  listSessions,
  loadBootSnapshot,
  loadSettings,
  savePlan as persistPlan,
  saveSettings as persistSettings,
  type AppSettings,
  type PlanTemplateWriteResult,
} from './db/repo';
import {
  atomicCreateSession,
  atomicDiscardSession,
  atomicFinishSession,
  atomicSaveHistoryEdit,
  atomicSaveSession,
  atomicSaveSessionWithTemplate,
  type WriteResult,
} from './db/tx';
import { readExerciseTemplates } from './db/templates';
import { withSetupNote } from './domain/setupNote';
import type { ExerciseTemplate, Plan, Session } from './domain/types';

export interface Toast {
  id: string;
  text: string;
  kind: 'info' | 'error' | 'ok';
}

export interface SaveArgs {
  /** 写入方 editorId（活动保存必需） */
  editorId?: string;
  /** 期望的当前 revision（活动保存/历史纠错必需，防止覆盖别人） */
  expectedRevision?: number;
  /** 结束后是否推进循环 */
  advanceCycle?: boolean;
  /** Wave 3A：结束训练时是否单事务把动作编排同步回原计划训练日（默认 false） */
  syncBackToPlanDay?: boolean;
  /** 锁校验级别 */
  lockPolicy?: 'required' | 'optional';
}

interface StoreValue {
  ready: boolean;
  initError: string | null;
  settings: AppSettings;
  plans: Plan[];
  sessions: Session[];
  /** Wave 1C.3：全部历史记录是否已完成全量水合（≤40 条首阶段即为 true；>40 条首屏后后台补齐） */
  historyHydrated: boolean;
  /** Wave 1C.3：按需幂等拉齐完整历史（统计/历史/上次参考兜底使用） */
  ensureFullHistory: () => Promise<Session[]>;
  activeSession: Session | null;
  /** 未结束训练列表（正常情况下长度 ≤ 1，旧数据可能更多） */
  activeSessions: Session[];
  toasts: Toast[];
  pushToast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
  setTheme: (theme: AppSettings['theme']) => Promise<void>;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** B2/G5-R6：返回**真实**成功/失败，调用方据此准确提示，不能假报回退成功 */
  setCurrentPlan: (planId: string | null) => Promise<boolean>;
  refreshSettings: () => Promise<void>;
  refreshPlans: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  upsertPlan: (plan: Plan) => Promise<Plan>;
  /** Wave 2A：单事务保存计划 + 可选动作配置记忆（冲突或失败整体回滚） */
  upsertPlanWithTemplate: (
    plan: Plan,
    templateWrite?: { template: ExerciseTemplate; expectedRevision: number | null },
  ) => Promise<PlanTemplateWriteResult>;

  /** 只更新内存（写事务成功后调用；不落库） */
  syncSessionLocal: (next: Session) => void;
  setActiveSessionLocal: (s: Session | null) => void;
  clearActive: () => void;

  /** 受约束写入入口 */
  createTrainingSession: (session: Session) => Promise<WriteResult>;
  saveActiveSession: (next: Session, args: SaveArgs) => Promise<WriteResult>;
  /** G1：保存当前训练 + 可选模板记忆（同一事务，模板 revision 冲突整体回滚） */
  saveActiveSessionWithTemplate: (
    next: Session,
    args: SaveArgs,
    template: ExerciseTemplate,
    templateExpectedRevision: number | null,
  ) => Promise<WriteResult>;
  finishTrainingSession: (next: Session, args: SaveArgs) => Promise<WriteResult>;
  discardTrainingSession: (next: Session, args: SaveArgs) => Promise<WriteResult>;
  saveHistorySession: (next: Session, expectedRevision: number) => Promise<WriteResult>;
  /** G1：动作配置记忆（只读缓存；G2 编辑器消费） */
  exerciseTemplates: ExerciseTemplate[];
  /** 模板缓存读取错误（不能当成“没有记忆”静默进入首次保存） */
  exerciseTemplateError: string | null;
  refreshExerciseTemplates: () => Promise<void>;
}

const Ctx = createContext<StoreValue | null>(null);

const THEME_META = { light: '#f4efe2', dark: '#17150f' } as const;

function applyTheme(theme: AppSettings['theme']) {
  const root = document.documentElement;
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  root.setAttribute('data-theme', resolved);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_META[resolved]);
}

/** 把一条记录并入 sessions 列表（按 id 替换或插入） */
function mergeSession(list: Session[], next: Session): Session[] {
  const idx = list.findIndex((x) => x.id === next.id);
  if (idx < 0) return [next, ...list];
  const copy = [...list];
  copy[idx] = next;
  return copy;
}

/**
 * Wave 1C.3：后台全量历史水合与内存并发改动的 revision 安全合并。
 *
 * · 内存中有而 DB 快照尚无的新建会话：保留内存最新记录；
 * · 同 id 同时存在：以 revision 更高（相等时优先内存）的一方为准，绝不覆盖用户刚录入的组次；
 * · 按 startedAt 倒序输出。
 */
export function mergeHydratedSessions(memList: Session[], dbList: Session[]): Session[] {
  const byId = new Map<string, Session>();
  for (const db of dbList) {
    byId.set(db.id, db);
  }
  for (const mem of memList) {
    const existing = byId.get(mem.id);
    if (!existing) {
      byId.set(mem.id, mem);
      continue;
    }
    const memRev = typeof mem.revision === 'number' ? mem.revision : 0;
    const dbRev = typeof existing.revision === 'number' ? existing.revision : 0;
    if (memRev >= dbRev) {
      byId.set(mem.id, mem);
    }
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const historyHydratedRef = useRef(false);
  const sessionsRef = useRef<Session[]>([]);
  const fullHistoryInFlightRef = useRef<Promise<Session[]> | null>(null);
  const hydrationEpochRef = useRef(0);
  const [exerciseTemplates, setExerciseTemplates] = useState<ExerciseTemplate[]>([]);
  const [exerciseTemplateError, setExerciseTemplateError] = useState<string | null>(null);
  const [activeSession, setActiveSessionState] = useState<Session | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimers = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
  }, []);

  const pushToast = useCallback(
    (text: string, kind: Toast['kind'] = 'info') => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((list) => [...list, { id, text, kind }].slice(-3));
      const timer = window.setTimeout(() => dismissToast(id), kind === 'error' ? 6200 : 2800);
      toastTimers.current.set(id, timer);
    },
    [dismissToast],
  );

  const refreshPlans = useCallback(async () => {
    setPlans(await listPlans());
  }, []);

  const refreshSessions = useCallback(async () => {
    hydrationEpochRef.current += 1;
    fullHistoryInFlightRef.current = null;
    const all = await listSessions();
    historyHydratedRef.current = true;
    setHistoryHydrated(true);
    sessionsRef.current = all;
    setSessions(all);
    // 内存里的 activeSession 跟着库走，避免不一致
    const active = all.filter((s) => s.status === 'active').sort((a, b) => b.startedAt - a.startedAt);
    setActiveSessionState(active[0] ?? null);
  }, []);

  const ensureFullHistory = useCallback((): Promise<Session[]> => {
    if (historyHydratedRef.current) {
      return Promise.resolve(sessionsRef.current);
    }
    if (fullHistoryInFlightRef.current) {
      return fullHistoryInFlightRef.current;
    }
    const epoch = hydrationEpochRef.current;
    const job = listSessions()
      .then((dbAll) => {
        if (epoch !== hydrationEpochRef.current) {
          return sessionsRef.current;
        }
        let merged = dbAll;
        setSessions((prev) => {
          merged = mergeHydratedSessions(prev, dbAll);
          sessionsRef.current = merged;
          return merged;
        });
        setActiveSessionState((cur) => {
          if (cur && cur.status === 'active') return cur;
          const active = merged
            .filter((s) => s.status === 'active')
            .sort((a, b) => b.startedAt - a.startedAt);
          return active[0] ?? null;
        });
        historyHydratedRef.current = true;
        setHistoryHydrated(true);
        return merged;
      })
      .finally(() => {
        if (fullHistoryInFlightRef.current === job) {
          fullHistoryInFlightRef.current = null;
        }
      });
    fullHistoryInFlightRef.current = job;
    return job;
  }, []);

  const refreshExerciseTemplates = useCallback(async () => {
    try {
      const snap = await readExerciseTemplates();
      setExerciseTemplates(snap.templates);
      setExerciseTemplateError(
        snap.invalid.length
          ? `动作配置记忆有 ${snap.invalid.length} 条损坏项（${snap.invalid[0].key}），本次不会把它当作“无记忆”`
          : null,
      );
    } catch (err) {
      setExerciseTemplates([]);
      setExerciseTemplateError(err instanceof Error ? err.message : '动作配置记忆读取失败');
    }
  }, []);

  /** 所有未结束的训练（用于「单活动训练」引导与恢复入口，审计 R2-04） */
  const activeSessions = useMemo(
    () => sessions.filter((s) => s.status === 'active').sort((a, b) => b.startedAt - a.startedAt),
    [sessions],
  );

  useEffect(() => {
    let cancelled = false;
    let stage2Timer: number | null = null;
    (async () => {
      try {
        await ensureSeed();
        const boot = await loadBootSnapshot();
        if (cancelled) return;
        setSettings(boot.settings);
        applyTheme(boot.settings.theme);
        setPlans(boot.plans);
        sessionsRef.current = boot.sessions;
        setSessions(boot.sessions);
        setExerciseTemplates(boot.templateSnap.templates);
        setExerciseTemplateError(
          boot.templateSnap.invalid.length
            ? `动作配置记忆有 ${boot.templateSnap.invalid.length} 条损坏项（${boot.templateSnap.invalid[0].key}），本次不会把它当作“无记忆”`
            : null,
        );
        setActiveSessionState(boot.activeSession);
        historyHydratedRef.current = boot.isComplete;
        setHistoryHydrated(boot.isComplete);
        setReady(true);
        if (!boot.isComplete) {
          stage2Timer = window.setTimeout(() => {
            if (!cancelled) {
              void ensureFullHistory().catch(() => {
                /* 后台水合异常保留首阶段结果，消费全量历史的页面进入时会再次幂等拉取 */
              });
            }
          }, 0);
        }
      } catch (err) {
        if (cancelled) return;
        setInitError(err instanceof Error ? err.message : '本地数据库初始化失败');
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      if (stage2Timer !== null) {
        window.clearTimeout(stage2Timer);
      }
    };
  }, [ensureFullHistory]);

  // system 主题跟随系统变化
  useEffect(() => {
    if (settings.theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [settings.theme]);

  const setTheme = useCallback(
    async (theme: AppSettings['theme']) => {
      applyTheme(theme);
      setSettings((s) => ({ ...s, theme }));
      try {
        await persistSettings({ theme });
      } catch (err) {
        pushToast(err instanceof Error ? `主题偏好未保存：${err.message}` : '主题偏好未保存', 'error');
      }
    },
    [pushToast],
  );

  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const requested = { ...patch };
      await persistSettings(requested);
      // 只合并已提交的本次字段，保留并发 UI 更新；失败由调用方给出上下文提示。
      setSettings((s) => ({ ...s, ...requested, key: 'app' }));
    },
    [],
  );

  const refreshSettings = useCallback(async () => {
    try {
      const s = await loadSettings();
      setSettings(s);
      applyTheme(s.theme);
    } catch (err) {
      pushToast(err instanceof Error ? `设置读取失败：${err.message}` : '设置读取失败', 'error');
    }
  }, [pushToast]);

  /**
   * 切换训练用计划。
   *
   * ── B2/G5-R6 修复 ────────────────────────────────────────────
   * 旧实现 catch 后只弹 toast、**既不抛错也不返回失败**，于是调用方
   * `await setCurrentPlan(...)` 之后无法判断结果。真实后果：
   * 删除当前计划后 settings 持久化失败，计划已删、DB 仍留旧 current 悬空引用，
   * 但外层照常弹"已回退"——**假报成功**。
   *
   * 现在：返回 `true/false` 真实结果，失败时同时**回滚内存**到原值，
   * 让调用方能给出准确提示或恢复语义。
   */
  const setCurrentPlan = useCallback(
    async (planId: string | null): Promise<boolean> => {
      let previous: string | null = null;
      setSettings((s) => {
        previous = s.currentPlanId ?? null;
        return { ...s, currentPlanId: planId };
      });
      try {
        await persistSettings({ currentPlanId: planId });
        return true;
      } catch (err) {
        // 持久化失败：回滚内存，避免内存与 DB 不一致
        setSettings((s) => ({ ...s, currentPlanId: previous }));
        pushToast(err instanceof Error ? `计划选择未保存：${err.message}` : '计划选择未保存', 'error');
        return false;
      }
    },
    [pushToast],
  );

  const upsertPlan = useCallback(async (plan: Plan) => {
    const saved = await persistPlan(plan);
    setPlans((list) => {
      const idx = list.findIndex((p) => p.id === saved.id);
      if (idx < 0) return [...list, saved];
      const next = [...list];
      next[idx] = saved;
      return next;
    });
    return saved;
  }, []);

  const upsertPlanWithTemplate = useCallback(
    async (
      plan: Plan,
      templateWrite?: { template: ExerciseTemplate; expectedRevision: number | null },
    ): Promise<PlanTemplateWriteResult> => {
      const r = await atomicSavePlanWithTemplate(plan, templateWrite);
      if (!r.ok) return r;
      setPlans((list) => {
        const idx = list.findIndex((p) => p.id === r.plan.id);
        if (idx < 0) return [...list, r.plan];
        const next = [...list];
        next[idx] = r.plan;
        return next;
      });
      if (r.template) {
        try {
          await refreshExerciseTemplates();
        } catch (err) {
          pushToast(
            err instanceof Error ? `动作配置记忆刷新失败：${err.message}` : '动作配置记忆刷新失败',
            'error',
          );
        }
      }
      return r;
    },
    [pushToast, refreshExerciseTemplates],
  );

  /** activeSession 始终只指向 status==='active' 的训练（与数据库查询同一条件） */
  const setActiveSessionLocal = useCallback((s: Session | null) => {
    const onlyActive = s && s.status === 'active' ? s : null;
    setActiveSessionState(onlyActive);
    if (s) {
      setSessions((list) => {
        const next = mergeSession(list, s);
        sessionsRef.current = next;
        return next;
      });
    }
  }, []);

  /**
   * 只更新内存：写事务已经成功，这里**不再落库**（V3-01 / D20）。
   */
  const syncSessionLocal = useCallback((next: Session) => {
    setActiveSessionState((cur) => {
      if (next.status === 'active') return next;
      // 终态记录必须从 activeSession 槽位移除
      if (cur && cur.id === next.id) return null;
      return cur;
    });
    setSessions((list) => {
      const merged = mergeSession(list, next);
      sessionsRef.current = merged;
      return merged;
    });
  }, []);

  const clearActive = useCallback(() => setActiveSessionState(null), []);

  /* ── 受约束写入入口：写库 + 成功后只更新内存 ─────────── */

  const afterWrite = useCallback(
    (r: WriteResult, opts: { refreshPlansOnAdvance?: boolean } = {}) => {
      if (!r.ok) return r;
      syncSessionLocal(r.session);
      if (opts.refreshPlansOnAdvance && r.plan) {
        const moved = r.plan;
        setPlans((list) => {
          const idx = list.findIndex((p) => p.id === moved.id);
          if (idx < 0) return list;
          const next = [...list];
          next[idx] = moved;
          return next;
        });
      }
      return r;
    },
    [syncSessionLocal],
  );

  const createTrainingSession = useCallback(
    async (session: Session) => {
      const templates = new Map(exerciseTemplates.map((template) => [template.exerciseId, template]));
      const exercises = session.exercises.map((exercise) => {
        const template = templates.get(exercise.exerciseId);
        return template ? withSetupNote(exercise, template.setupNote) : exercise;
      });
      const r = await atomicCreateSession({ session: { ...session, exercises } });
      return afterWrite(r);
    },
    [afterWrite, exerciseTemplates],
  );

  const saveActiveSession = useCallback(
    async (next: Session, args: SaveArgs) => {
      const r = await atomicSaveSession({
        session: next,
        guard: {
          sessionId: next.id,
          editorId: args.editorId ?? '',
          expectedVersion: args.expectedRevision,
        },
      });
      return afterWrite(r);
    },
    [afterWrite],
  );

  const saveActiveSessionWithTemplate = useCallback(
    async (
      next: Session,
      args: SaveArgs,
      template: ExerciseTemplate,
      templateExpectedRevision: number | null,
    ) => {
      const r = await atomicSaveSessionWithTemplate({
        session: next,
        guard: {
          sessionId: next.id,
          editorId: args.editorId ?? '',
          expectedVersion: args.expectedRevision,
        },
        template,
        templateExpectedRevision,
      });
      /**
       * 事务提交与缓存刷新分离：刷新失败不能把已提交的保存报成整次失败
       * （否则 UI 重试会以为没保存）。缓存错误提示可恢复，不影响 r.ok。
       */
      if (r.ok) {
        try {
          await refreshExerciseTemplates();
        } catch (err) {
          pushToast(err instanceof Error ? `动作配置记忆刷新失败：${err.message}` : '动作配置记忆刷新失败', 'error');
        }
      }
      return afterWrite(r);
    },
    [afterWrite, refreshExerciseTemplates],
  );

  const finishTrainingSession = useCallback(
    async (next: Session, args: SaveArgs) => {
      const r = await atomicFinishSession({
        session: next,
        guard: {
          sessionId: next.id,
          editorId: args.editorId,
          advanceCycle: args.advanceCycle,
          syncBackToPlanDay: args.syncBackToPlanDay,
          expectedVersion: args.expectedRevision,
          lockPolicy: args.lockPolicy ?? 'required',
        },
      });
      return afterWrite(r, { refreshPlansOnAdvance: true });
    },
    [afterWrite],
  );

  const discardTrainingSession = useCallback(
    async (next: Session, args: SaveArgs) => {
      const r = await atomicDiscardSession({
        session: next,
        guard: {
          editorId: args.editorId,
          expectedVersion: args.expectedRevision,
          lockPolicy: args.lockPolicy ?? 'optional',
        },
      });
      return afterWrite(r);
    },
    [afterWrite],
  );

  const saveHistorySession = useCallback(
    async (next: Session, expectedRevision: number) => {
      const r = await atomicSaveHistoryEdit({ session: next, expectedRevision });
      return afterWrite(r);
    },
    [afterWrite],
  );

  const value = useMemo<StoreValue>(
    () => ({
      ready,
      initError,
      settings,
      plans,
      sessions,
      historyHydrated,
      ensureFullHistory,
      activeSession,
      activeSessions,
      toasts,
      pushToast,
      dismissToast,
      setTheme,
      patchSettings,
      setCurrentPlan,
      refreshSettings,
      refreshPlans,
      refreshSessions,
      upsertPlan,
      upsertPlanWithTemplate,
      syncSessionLocal,
      setActiveSessionLocal,
      clearActive,
      createTrainingSession,
      saveActiveSession,
      saveActiveSessionWithTemplate,
      finishTrainingSession,
      discardTrainingSession,
      saveHistorySession,
      exerciseTemplates,
      exerciseTemplateError,
      refreshExerciseTemplates,
    }),
    [
      ready,
      initError,
      settings,
      plans,
      sessions,
      historyHydrated,
      ensureFullHistory,
      activeSession,
      activeSessions,
      toasts,
      pushToast,
      dismissToast,
      setTheme,
      patchSettings,
      setCurrentPlan,
      refreshSettings,
      refreshPlans,
      refreshSessions,
      upsertPlan,
      upsertPlanWithTemplate,
      syncSessionLocal,
      setActiveSessionLocal,
      clearActive,
      createTrainingSession,
      saveActiveSession,
      saveActiveSessionWithTemplate,
      finishTrainingSession,
      discardTrainingSession,
      saveHistorySession,
      exerciseTemplates,
      exerciseTemplateError,
      refreshExerciseTemplates,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore 必须在 StoreProvider 内使用');
  return v;
}
