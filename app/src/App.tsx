import { useEffect } from 'react';
import { useRoute } from './lib/router';
import { useStore } from './store';
import { Toasts } from './ui/Toasts';
import { TabBar } from './ui/TabBar';
import { Home } from './pages/Home';
import { SessionPage } from './pages/Session';
import { HistoryPage, HistoryDetailPage } from './pages/History';
import { StatsPage } from './pages/Stats';
import { PlansPage, PlanDayEditor } from './pages/Plans';
import { SettingsPage } from './pages/Settings';
import { installViewportGuard } from './lib/storage';
import { navigate } from './lib/router';
import { installSelectionGuard } from './ui/selectionGuard';

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
    body = <HistoryDetailPage key={parts[1]} id={parts[1]} />;
  } else if (parts[0] === 'history') {
    body = <HistoryPage />;
  } else if (parts[0] === 'stats') {
    body = <StatsPage focusExercise={query.get('exercise') ?? undefined} />;
  } else if (parts[0] === 'plans') {
    body = <PlansPage />;
  } else if (parts[0] === 'plan' && parts[1] && parts[2] === 'day' && parts[3]) {
    body = <PlanDayEditor planId={parts[1]} dayId={parts[3]} />;
  } else if (parts[0] === 'settings') {
    body = <SettingsPage />;
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
        {body}
        <TabBar path={path} />
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
