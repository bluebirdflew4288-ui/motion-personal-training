/**
 * G3B 手势验证入口：真实 SessionPage + 10 张力量卡 + 2 张有氧卡。
 * 只用于手势/排序集成验证；数据全部合成，使用隔离 IndexedDB。
 */
export const g3bEntry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './src/store';
import { App } from './src/App';
import { ensureSeed, listPlans, getSession } from './src/db/repo';
import { createSession } from './src/domain/session';
import { createCardioEntry } from './src/domain/cardio';
import { atomicCreateSession } from './src/db/tx';
import { navigate } from './src/lib/router';
import { readExerciseTemplates } from './src/db/templates';

async function boot() {
  await ensureSeed();
  const plans = await listPlans();
  const plan = plans[0];
  const day = plan.days[0];
  const session = createSession(plan, day);
  session.id = 'g3b-session';
  const base = session.exercises[0];
  session.exercises = Array.from({ length: 10 }, (_, i) => ({
    ...structuredClone(base),
    id: 'g3b-ex-' + (i + 1),
    name: 'G3B动作' + (i + 1),
    exerciseId: 'custom:g3b-' + (i + 1),
    planExerciseId: null,
    restSec: 60,
    target: { kind: 'straight', sets: 1, setsMax: 1, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 20 },
    groups: [{ index: 1, stageCount: 1 }],
    sets: [{ id: 'g3b-set-' + (i + 1), roundIndex: 1, stageIndex: 1, reps: null, weightKg: null, status: 'blank' }],
  }));
  session.cardio = ['g3b-cardio-1', 'g3b-cardio-2'].map((id, i) => ({
    ...createCardioEntry({ preset: 'treadmill-incline', name: 'G3B有氧' + (i + 1), params: { speedKmh: 4, inclinePct: 5 } }),
    id,
  }));
  // 全新上下文中行为不变；同一页面 reload 的 readonly 锁门禁测试需要复用已有 session。
  if (!(await getSession('g3b-session'))) {
    const created = await atomicCreateSession({ session });
    if (!created.ok) throw new Error('seed failed');
  }

  window.__db = {
    getSession,
    listPlans,
    getTemplates: readExerciseTemplates,
    saveCount: 0,
  };
  window.__test = {
    order: async () => {
      const s = await getSession('g3b-session');
      return {
        strength: s.exercises.map((e) => e.id),
        cardio: (s.cardio || []).map((c) => c.id),
        revision: s.revision,
        setsJson: JSON.stringify(s.exercises.map((e) => e.sets)),
        setsById: Object.fromEntries(s.exercises.map((e) => [e.id, JSON.stringify(e.sets.map((x) => [x.id, x.reps, x.weightKg, x.status]))])),
      };
    },
    scrollY: () => window.scrollY,
    resetScroll: () => window.scrollTo(0, 0),
  };
  createRoot(document.getElementById('root')).render(
    React.createElement(React.StrictMode, null, React.createElement(StoreProvider, null, React.createElement(App))),
  );
  navigate('/session/' + session.id, true);
  window.__booted = true;
}
boot().catch((err) => { window.__bootError = String(err); });
`;
