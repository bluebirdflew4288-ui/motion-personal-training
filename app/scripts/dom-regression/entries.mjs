/**
 * 真实 DOM 回归测试挂载入口集
 * 包含：
 *   - draftEntry: DraftCell Esc 与非法 raw 回滚验证挂载
 *   - historyEntry: History 真实 App/Store/IDB 状态机挂载（删除、守卫、意图、Forward、blur）
 *   - restEntry: 休息计时器 React Hook 真实状态挂载（reload 恢复、暂停、加减时）
 *   - nativeBoundary: 原生通知桥接模拟桩（验证 Native 异步查询与撤销契约）
 */

export const draftEntry = `
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DraftCell } from './src/ui/DraftCell';

function Probe() {
  const [value, setValue] = useState(10);
  const [valid, setValid] = useState(true);
  const [commits, setCommits] = useState([]);
  window.auditState = { value, valid, commits };
  return (
    <>
      <DraftCell
        value={value}
        ariaLabel="audit-cell"
        onCommit={(n) => {
          setValue(n);
          setCommits((v) => [...v, n]);
        }}
        onValidityChange={setValid}
      />
      <output id="state">{JSON.stringify({ value, valid, commits })}</output>
    </>
  );
}

createRoot(document.getElementById('root')).render(
  __AUDIT_STRICT__ ? <StrictMode><Probe /></StrictMode> : <Probe />
);
`;

export const historyEntry = `
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './src/App';
import { StoreProvider, useStore } from './src/store';
import { createSession } from './src/domain/session';
import { ensureSeed, listPlans, saveSession, getSession, deleteSession } from './src/db/repo';
import { openDb } from './src/db/idb';
import { navigate, back } from './src/lib/router';
import { handleBackIntent } from './src/lib/nativeBack';

const put = IDBObjectStore.prototype.put;
const del = IDBObjectStore.prototype.delete;

IDBObjectStore.prototype.delete = function (...args) {
  if (window.auditFailDelete && this.name === 'sessions') {
    throw new DOMException('AUDIT synthetic delete failure', 'QuotaExceededError');
  }
  return del.apply(this, args);
};

IDBObjectStore.prototype.put = function (...args) {
  if (window.auditFailSave && this.name === 'sessions') {
    throw new DOMException('AUDIT synthetic write failure', 'QuotaExceededError');
  }
  return put.apply(this, args);
};

function AuditStoreAccess() {
  const store = useStore();
  window.auditRefreshSessions = store.refreshSessions;
  return null;
}

async function boot() {
  await ensureSeed();
  const p = (await listPlans())[0];
  let s = createSession(p, p.days[0]);
  s.id = 'audit-history-a';
  s.status = 'completed';
  s.endedAt = s.startedAt + 60000;
  s.note = 'original note';
  const first = s.exercises[0]?.sets[0];
  if (first) {
    first.reps = 10;
    first.status = 'done';
  }
  const prior = await getSession(s.id);
  if (new URLSearchParams(location.search).has('reuse') && prior) {
    s = prior;
  } else {
    await saveSession(s);
  }

  const other = structuredClone(s);
  other.id = 'audit-history-b';
  other.day.dayName = 'Synthetic record B';
  other.note = 'second original note';
  if (other.exercises[0]?.sets[0]) {
    other.exercises[0].sets[0].reps = 20;
  }
  if (!new URLSearchParams(location.search).has('reuse') || !(await getSession(other.id))) {
    await saveSession(other);
  }

  window.audit = {
    getSession,
    deleteSession,
    navigate,
    back,
    handleBackIntent,
    id: s.id,
    otherId: other.id,
    holdWrites: async () => {
      const db = await openDb();
      const tx = db.transaction('sessions', 'readwrite');
      const os = tx.objectStore('sessions');
      window.auditHolding = true;
      await new Promise((resolve, reject) => {
        let first = true;
        const ping = () => {
          const r = os.get(s.id);
          r.onsuccess = () => {
            if (first) {
              first = false;
              resolve();
            }
            if (window.auditHolding) ping();
          };
          r.onerror = () => reject(r.error);
        };
        ping();
      });
    },
    releaseWrites: () => {
      window.auditHolding = false;
    },
  };

  createRoot(document.getElementById('root')).render(
    __AUDIT_STRICT__ ? (
      <StrictMode>
        <StoreProvider>
          <AuditStoreAccess />
          <App />
        </StoreProvider>
      </StrictMode>
    ) : (
      <StoreProvider>
        <AuditStoreAccess />
        <App />
      </StoreProvider>
    )
  );

  if (new URLSearchParams(location.search).has('single')) {
    navigate('/history/' + s.id, true);
  } else {
    navigate('/history', true);
    navigate('/history/' + s.id);
  }
  window.auditReady = true;
}

boot().catch((e) => {
  window.auditBootError = String(e);
  throw e;
});
`;

export const restEntry = `
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useRestTimer } from './src/ui/RestTimer';

const q = new URLSearchParams(location.search);
const sid = 'audit-rest-session';
if (q.has('seed')) {
  sessionStorage.setItem(
    'motion-rest-timer:' + sid,
    JSON.stringify({
      v: 1,
      sessionId: sid,
      token: 'audit-rest',
      generation: q.has('known') ? 4 : null,
      endsAt: Date.now() + 60000,
      pausedRemaining: null,
      status: 'running',
      intentWatermark: 1,
      savedAt: Date.now(),
    })
  );
}

function Probe() {
  const api = useRestTimer(60, sid);
  window.api = api;
  return (
    <output id="state">
      {JSON.stringify({
        active: api.active,
        endsAt: api.endsAt,
        pausedRemaining: api.pausedRemaining,
        token: api.token,
        source: api.source,
        cancelPending: api.cancelPending,
        cancelFailed: api.cancelFailed,
      })}
    </output>
  );
}

createRoot(document.getElementById('root')).render(
  q.has('strict') ? <StrictMode><Probe /></StrictMode> : <Probe />
);
`;

export const nativeBoundary = `
window.nativeTrace = { cancels: [], schedules: [], queries: [] };
window.nativeResolvers = [];
let tokenSeq = 0;

export function getActiveRest() {
  window.nativeTrace.queries.push(Date.now());
  const mode = new URLSearchParams(location.search).get('query');
  if (mode === 'reject') return Promise.reject(new Error('AUDIT unavailable native query'));
  if (mode === 'unavailable') return Promise.resolve({ available: false, active: false });
  return new Promise((resolve) => window.nativeResolvers.push(resolve));
}

export function cancelRestReminder(identity) {
  window.nativeTrace.cancels.push(identity);
  return Promise.resolve(true);
}

export function scheduleRestReminder(...args) {
  window.nativeTrace.schedules.push(args);
  return Promise.resolve({
    scheduled: true,
    generation: 5 + window.nativeTrace.schedules.length,
  });
}

export function newRestToken() {
  return 'audit-new-token-' + (++tokenSeq);
}
`;
