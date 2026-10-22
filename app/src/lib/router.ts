/* 极简 hash 路由：静态服务器不需要 rewrite，刷新不会 404。 */
import { useEffect, useState } from 'react';

export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart || '/';
  return {
    path,
    parts: path.split('/').filter(Boolean),
    query: new URLSearchParams(queryPart ?? ''),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string, replace = false): void {
  const target = `#${path}`;
  if (replace) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

export function back(fallback = '/'): void {
  if (window.history.length > 1) window.history.back();
  else navigate(fallback, true);
}
