/* 应用状态：设置 / 计划列表 / 当前激活训练。
   · 所有写操作先落 IndexedDB，成功后才更新内存状态。
   · 保存失败会向 UI 抛出 saveError，绝不在失败后显示"已保存"。 */

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
  DEFAULT_SETTINGS,
  ensureSeed,
  findActiveSession,
  listPlans,
  listSessions,
  loadSettings,
  savePlan as persistPlan,
  saveSession as persistSession,
  saveSettings as persistSettings,
  type AppSettings,
} from './db/repo';
import type { Plan, Session } from './domain/types';

export interface Toast {
  id: string;
  text: string;
  kind: 'info' | 'error' | 'ok';
}

interface StoreValue {
  ready: boolean;
  initError: string | null;
  settings: AppSettings;
  plans: Plan[];
  sessions: Session[];
  activeSession: Session | null;
  /** 未结束训练列表（正常情况下长度 ≤ 1，旧数据可能更多） */
  activeSessions: Session[];
  toasts: Toast[];
  pushToast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
  setTheme: (theme: AppSettings['theme']) => Promise<void>;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setCurrentPlan: (planId: string | null) => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshPlans: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  upsertPlan: (plan: Plan) => Promise<Plan>;
  setActiveSession: (s: Session | null) => void;
  updateSession: (next: Session) => Promise<void>;
  completeSession: (next: Session) => Promise<void>;
  clearActive: () => void;
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

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
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
    const all = await listSessions();
    setSessions(all);
    // 内存里的 activeSession 跟着库走，避免不一致
    const active = all.filter((s) => s.status === 'active').sort((a, b) => b.startedAt - a.startedAt);
    setActiveSessionState(active[0] ?? null);
  }, []);

  /** 所有未结束的训练（用于「单活动训练」引导与恢复入口，审计 R2-04） */
  const activeSessions = useMemo(
    () => sessions.filter((s) => s.status === 'active').sort((a, b) => b.startedAt - a.startedAt),
    [sessions],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureSeed();
        const [s, p, sess, active] = await Promise.all([
          loadSettings(),
          listPlans(),
          listSessions(),
          findActiveSession(),
        ]);
        if (cancelled) return;
        setSettings(s);
        applyTheme(s.theme);
        setPlans(p);
        setSessions(sess);
        setActiveSessionState(active ?? null);
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setInitError(err instanceof Error ? err.message : '本地数据库初始化失败');
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      setSettings((s) => ({ ...s, ...patch }));
      try {
        const saved = await persistSettings(patch);
        setSettings(saved);
      } catch (err) {
        pushToast(err instanceof Error ? `设置未保存：${err.message}` : '设置未保存', 'error');
      }
    },
    [pushToast],
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

  const setCurrentPlan = useCallback(
    async (planId: string | null) => {
      setSettings((s) => ({ ...s, currentPlanId: planId }));
      try {
        await persistSettings({ currentPlanId: planId });
      } catch (err) {
        pushToast(err instanceof Error ? `计划选择未保存：${err.message}` : '计划选择未保存', 'error');
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

  /** activeSession 始终只指向 status==='active' 的训练（与数据库查询同一条件） */
  const setActiveSession = useCallback((s: Session | null) => {
    const onlyActive = s && s.status === 'active' ? s : null;
    setActiveSessionState(onlyActive);
    if (s) setSessions((list) => {
      const idx = list.findIndex((x) => x.id === s.id);
      if (idx < 0) return [s, ...list];
      const next = [...list];
      next[idx] = s;
      return next;
    });
  }, []);

  const updateSession = useCallback(
    async (next: Session) => {
      await persistSession(next);
      // 已结束/已放弃的训练不能回到 activeSession 槽位
      setActiveSessionState(next.status === 'active' ? next : null);
      setSessions((list) => {
        const idx = list.findIndex((x) => x.id === next.id);
        if (idx < 0) return [next, ...list];
        const copy = [...list];
        copy[idx] = next;
        return copy;
      });
    },
    [],
  );

  const completeSession = useCallback(async (next: Session) => {
    await persistSession(next);
    setActiveSessionState(null);
    setSessions((list) => {
      const idx = list.findIndex((x) => x.id === next.id);
      if (idx < 0) return [next, ...list];
      const copy = [...list];
      copy[idx] = next;
      return copy;
    });
  }, []);

  const clearActive = useCallback(() => setActiveSessionState(null), []);

  const value = useMemo<StoreValue>(
    () => ({
      ready,
      initError,
      settings,
      plans,
      sessions,
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
      setActiveSession,
      updateSession,
      completeSession,
      clearActive,
    }),
    [
      ready,
      initError,
      settings,
      plans,
      sessions,
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
      setActiveSession,
      updateSession,
      completeSession,
      clearActive,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore 必须在 StoreProvider 内使用');
  return v;
}
