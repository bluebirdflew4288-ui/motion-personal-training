import { lazy, Suspense, useEffect, useRef } from 'react';
import { useRoute } from './lib/router';
import { useStore } from './store';
import { Toasts } from './ui/Toasts';
import { TabBar } from './ui/TabBar';
import { Home } from './pages/Home';
import { SessionPage } from './pages/Session';
import { installViewportGuard } from './lib/storage';
import { navigate } from './lib/router';
import { installSelectionGuard } from './ui/selectionGuard';

type HistoryMod = typeof import('./pages/History');
type StatsMod = typeof import('./pages/Stats');
type PlansMod = typeof import('./pages/Plans');
type SettingsMod = typeof import('./pages/Settings');

let resolvedHistoryMod: HistoryMod | null = null;
let resolvedStatsMod: StatsMod | null = null;
let resolvedPlansMod: PlansMod | null = null;
let resolvedSettingsMod: SettingsMod | null = null;

let historyModPromise: Promise<HistoryMod> | null = null;
let statsModPromise: Promise<StatsMod> | null = null;
let plansModPromise: Promise<PlansMod> | null = null;
let settingsModPromise: Promise<SettingsMod> | null = null;

const loadHistoryMod = (): Promise<HistoryMod> =>
  (historyModPromise ??= import('./pages/History')
    .then((m) => {
      resolvedHistoryMod = m;
      return m;
    })
    .catch((err) => {
      historyModPromise = null;
      throw err;
    }));

const loadStatsMod = (): Promise<StatsMod> =>
  (statsModPromise ??= import('./pages/Stats')
    .then((m) => {
      resolvedStatsMod = m;
      return m;
    })
    .catch((err) => {
      statsModPromise = null;
      throw err;
    }));

const loadPlansMod = (): Promise<PlansMod> =>
  (plansModPromise ??= import('./pages/Plans')
    .then((m) => {
      resolvedPlansMod = m;
      return m;
    })
    .catch((err) => {
      plansModPromise = null;
      throw err;
    }));

const loadSettingsMod = (): Promise<SettingsMod> =>
  (settingsModPromise ??= import('./pages/Settings')
    .then((m) => {
      resolvedSettingsMod = m;
      return m;
    })
    .catch((err) => {
      settingsModPromise = null;
      throw err;
    }));

export function preloadRouteForPath(targetPath: string): void {
  if (targetPath.startsWith('/history')) {
    void loadHistoryMod().catch(() => {});
  } else if (targetPath.startsWith('/plans') || targetPath.startsWith('/plan')) {
    void loadPlansMod().catch(() => {});
  } else if (targetPath.startsWith('/stats')) {
    void loadStatsMod().catch(() => {});
  } else if (targetPath.startsWith('/settings')) {
    void loadSettingsMod().catch(() => {});
  }
}

export function preloadAllTabRoutes(): Promise<void> {
  return Promise.all([
    loadHistoryMod(),
    loadPlansMod(),
    loadStatsMod(),
    loadSettingsMod(),
  ]).then(
    () => undefined,
    () => undefined,
  );
}

const HistoryPage = lazy(() => loadHistoryMod().then((m) => ({ default: m.HistoryPage })));
const HistoryDetailPage = lazy(() => loadHistoryMod().then((m) => ({ default: m.HistoryDetailPage })));
const StatsPage = lazy(() => loadStatsMod().then((m) => ({ default: m.StatsPage })));
const PlansPage = lazy(() => loadPlansMod().then((m) => ({ default: m.PlansPage })));
const PlanDayEditor = lazy(() => loadPlansMod().then((m) => ({ default: m.PlanDayEditor })));
const SettingsPage = lazy(() => loadSettingsMod().then((m) => ({ default: m.SettingsPage })));

/**
 * 若挂载瞬间目标模块已预热完成则直接同步直出（0ms、不抛 Suspense）；
 * 若首屏直达深链时尚未预热完成则走 React.lazy，并在本次挂载生命周期内锁存同一组件类型，
 * 杜绝后台预热完成后父层重渲染导致 lazy -> direct 组件类型切换而丢失页面内未保存草稿。
 */
function PreloadedOrLazy<P extends Record<string, unknown>>({
  direct: Direct,
  lazyComp: LazyComp,
  componentProps,
}: {
  direct: React.ComponentType<P> | null;
  lazyComp: React.LazyExoticComponent<React.ComponentType<P>>;
  componentProps: P;
}) {
  const useDirectRef = useRef<boolean | null>(null);
  if (useDirectRef.current === null) {
    useDirectRef.current = Direct !== null;
  }
  const Chosen = useDirectRef.current && Direct ? Direct : LazyComp;
  return <Chosen {...componentProps} />;
}

function RouteSkeleton() {
  return (
    <main
      className="page page-top page-bottom-space"
      aria-busy="true"
      aria-label="页面加载中"
      data-testid="route-skeleton"
    >
      <div
        style={{
          height: 28,
          width: '38%',
          background: 'var(--paper-3)',
          borderRadius: 4,
          marginTop: 4,
        }}
      />
      <hr className="rule-line" style={{ marginTop: 10 }} />
      <div
        style={{
          height: 96,
          width: '100%',
          background: 'var(--paper-2)',
          border: '1px solid var(--rule)',
          marginTop: 14,
        }}
      />
    </main>
  );
}

function Boot() {
  const { ready, initError } = useStore();
  if (!ready) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div>
          <div style={{ fontFamily: 'var(--f-display)', fontSize: 40, letterSpacing: '-0.01em' }}>MOTION</div>
          <p style={{ color: 'var(--ink-3)', fontSize: 14 }}>正在读取本地训练数据…</p>
        </div>
      </div>
    );
  }
  if (initError) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="empty" style={{ maxWidth: 420 }}>
          <h2 className="empty-title">本地数据库无法打开</h2>
          <p className="empty-body">{initError}</p>
          <p className="empty-body" style={{ marginTop: 8 }}>
            常见原因：浏览器禁用了站点数据、使用了无痕模式，或另一个标签页占用了数据库。处理后刷新页面。
          </p>
        </div>
      </div>
    );
  }
  return <Routes />;
}

function Routes() {
  const route = useRoute();
  const { path, parts, query } = route;

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [path]);

  useEffect(() => {
    // 冷启动首帧上屏后立即空闲预热底部 4 个懒加载路由模块：
    // 既保留首屏主包体积缩减，又保证用户首次点击底部 Tab 时直接命中已解析组件 0ms 秒开。
    let idleId: number | null = null;
    let timerId: number | null = null;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const trigger = () => {
      void preloadAllTabRoutes();
    };
    const raf =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(() => {
            if (typeof win.requestIdleCallback === 'function') {
              idleId = win.requestIdleCallback(trigger, { timeout: 120 });
            } else {
              timerId = window.setTimeout(trigger, 24);
            }
          })
        : null;
    if (raf === null) {
      timerId = window.setTimeout(trigger, 24);
    }
    return () => {
      if (raf !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(raf);
      }
      if (idleId !== null && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleId);
      }
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  let body: React.ReactNode;
  if (parts[0] === 'session' && parts[1]) {
    /**
     * REVIEW-2 收尾 P2：用 key 绑定训练实例。
     *
     * 同一个组件实例从训练 A 切到训练 B 时（hash 变化但组件不卸载），
     * 计时状态与原生提醒归属都属于 A；不重挂会把 A 的计时显示在 B 上、
     * 甚至把 A 的 token 写进 B 的快照。
     * 以 sessionId 作为 key，保证跨训练切换一定重新挂载、状态彻底隔离。
     */
    body = <SessionPage key={parts[1]} sessionId={parts[1]} />;
  } else if (parts[0] === 'history' && parts[1]) {
    // 以记录 id 作 key：A→B 切换一定重新挂载，绝不把 A 的草稿/错误显示在 B 上
    body = (
      <PreloadedOrLazy
        key={`history-detail:${parts[1]}`}
        direct={resolvedHistoryMod?.HistoryDetailPage ?? null}
        lazyComp={HistoryDetailPage}
        componentProps={{ id: parts[1] }}
      />
    );
  } else if (parts[0] === 'history') {
    body = (
      <PreloadedOrLazy
        key="history"
        direct={resolvedHistoryMod?.HistoryPage ?? null}
        lazyComp={HistoryPage}
        componentProps={{}}
      />
    );
  } else if (parts[0] === 'stats') {
    body = (
      <PreloadedOrLazy
        key="stats"
        direct={resolvedStatsMod?.StatsPage ?? null}
        lazyComp={StatsPage}
        componentProps={{ focusExercise: query.get('exercise') ?? undefined }}
      />
    );
  } else if (parts[0] === 'plans') {
    body = (
      <PreloadedOrLazy
        key="plans"
        direct={resolvedPlansMod?.PlansPage ?? null}
        lazyComp={PlansPage}
        componentProps={{}}
      />
    );
  } else if (parts[0] === 'plan' && parts[1] && parts[2] === 'day' && parts[3]) {
    body = (
      <PreloadedOrLazy
        key={`plan-day:${parts[1]}:${parts[3]}`}
        direct={resolvedPlansMod?.PlanDayEditor ?? null}
        lazyComp={PlanDayEditor}
        componentProps={{ planId: parts[1], dayId: parts[3] }}
      />
    );
  } else if (parts[0] === 'settings') {
    body = (
      <PreloadedOrLazy
        key="settings"
        direct={resolvedSettingsMod?.SettingsPage ?? null}
        lazyComp={SettingsPage}
        componentProps={{}}
      />
    );
  } else if (parts.length === 0) {
    body = <Home />;
  } else {
    body = (
      <main className="page page-top">
        <div className="empty" style={{ marginTop: 32 }}>
          <div className="empty-mark">404</div>
          <h2 className="empty-title">页面不存在</h2>
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => navigate('/')}>
            回首页
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      <div className="app-shell">
        <Suspense fallback={<RouteSkeleton />}>{body}</Suspense>
        <TabBar path={path} onPreload={preloadRouteForPath} />
      </div>
      <Toasts />
    </>
  );
}

export function App() {
  useEffect(() => {
    const cleanViewport = installViewportGuard();
    const cleanSelection = installSelectionGuard();
    return () => {
      cleanSelection();
      cleanViewport?.();
    };
  }, []);
  return <Boot />;
}
