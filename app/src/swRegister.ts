/* Service Worker 注册与更新提示。
   更新只在用户确认后 activate，避免刷新打断正在进行的训练。 */

export function registerSW(): void {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    // 局域网 HTTP 下浏览器不注册 SW（非安全上下文）。功能照常，只是不缓存。
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI).pathname, { scope: './' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent('motion:update-available'));
            }
          });
        });
      })
      .catch(() => undefined);
  });
}
