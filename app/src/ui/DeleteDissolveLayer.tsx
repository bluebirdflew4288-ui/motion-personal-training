/* F10：删除成功后的**局部**消散展示层（纯渲染，无业务状态）。
   ── 为什么单独一层 ────────────────────────────────────────────
   Store 的保存出口（saveActiveSession → afterWrite → syncSessionLocal）
   会在删除事务成功后立刻刷新 Session，列表随之重渲染：原卡 DOM 可能已经
   不在了。因此这里显示的**不是**原卡，而是删除前惰性记录的盒子几何，
   加上一组新建的粒子节点——没有任何可操作元素、没有重复 id、
   没有输入/按钮/手势监听，也不进入文档流。 */
import type { CSSProperties } from 'react';
import type { DissolveGhost } from './deleteDissolve';

interface Props {
  ghosts: DissolveGhost[];
}

export function DeleteDissolveLayer({ ghosts }: Props) {
  if (!ghosts.length) return null;
  return (
    <div className="dissolve-layer" aria-hidden="true" data-testid="delete-dissolve-layer">
      {ghosts.map((g) => (
        <div
          key={g.token}
          className="dissolve-ghost"
          data-testid="delete-dissolve-ghost"
          data-dissolve-token={g.token}
          data-dissolve-item={g.itemId}
          data-dissolve-kind={g.kind}
          style={{
            top: g.rect.top,
            left: g.rect.left,
            width: g.rect.width,
            height: g.rect.height,
            '--dissolve-ms': `${g.durationMs}ms`,
          } as CSSProperties}
        >
          <span className="dissolve-shell" />
          {g.particles.map((p, i) => (
            <span
              key={`${g.token}:${i}`}
              className="dissolve-particle"
              data-testid="delete-dissolve-particle"
              data-tone={p.tone}
              style={{
                left: `${p.xPct}%`,
                top: `${p.yPct}%`,
                width: `${p.size}px`,
                height: `${p.size}px`,
                animationDelay: `${p.delayMs}ms`,
                animationDuration: `${p.durationMs}ms`,
                '--dx': `${p.dx}px`,
                '--dy': `${p.dy}px`,
                '--po': String(p.opacity),
              } as CSSProperties}
            />
          ))}
          <span className="dissolve-label">{g.name}</span>
        </div>
      ))}
    </div>
  );
}
