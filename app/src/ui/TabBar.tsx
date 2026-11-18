import { navigate } from '../lib/router';

const TABS = [
  { path: '/', label: '训练', ico: '练', match: (p: string) => p === '/' || p.startsWith('/session') },
  { path: '/history', label: '历史', ico: '史', match: (p: string) => p.startsWith('/history') },
  { path: '/plans', label: '计划', ico: '划', match: (p: string) => p.startsWith('/plans') || p.startsWith('/plan') },
  { path: '/stats', label: '统计', ico: '数', match: (p: string) => p.startsWith('/stats') },
  { path: '/settings', label: '设置', ico: '设', match: (p: string) => p.startsWith('/settings') },
];

export function TabBar({
  path,
  onPreload,
}: {
  path: string;
  onPreload?: (targetPath: string) => void;
}) {
  // 训练执行页占满全屏，不显示 tabbar（避免误触与遮挡输入）
  if (path.startsWith('/session')) return null;
  return (
    <nav className="tabbar" aria-label="主导航">
      <div className="tabbar-inner">
        {TABS.map((t) => {
          const active = t.match(path);
          return (
            <a
              key={t.path}
              href={`#${t.path}`}
              aria-current={active ? 'page' : undefined}
              onPointerDown={() => {
                onPreload?.(t.path);
              }}
              onClick={(e) => {
                e.preventDefault();
                navigate(t.path);
              }}
            >
              <span className="tab-ico" aria-hidden="true">
                {t.ico}
              </span>
              <span>{t.label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
