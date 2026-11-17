/**
 * R02 FIX2 真实 App 集成入口：实际 SessionPage + ExerciseEditor + 隔离 IndexedDB。
 * 覆盖：训练中 3/2 → +加一轮 → 3/2/2 → 打开编辑器无改保存仍 3/2/2；
 * 以及只改第 1 轮阶段名时第 2 轮配置不被连带修改（superset / dropSet 两种形式）。
 * 合成数据，不读用户真实库。
 */
export const r02Fix2Entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './src/store';
import { App } from './src/App';
import { ensureSeed, listPlans, getSession } from './src/db/repo';
import { createSession } from './src/domain/session';
import { atomicCreateSession } from './src/db/tx';
import { navigate } from './src/lib/router';
import { readExerciseTemplates } from './src/db/templates';

function stage(id, label, weightKg, repsMin, repsMax, toFailure, restAfterSec) {
  return { id, label, weightKg, repsMin, repsMax, toFailure, targetText: '', ...(restAfterSec === undefined ? {} : { restAfterSec }) };
}
function setRow(id, roundIndex, stageIndex, stageId, toFailure) {
  return { id, roundIndex, stageIndex, stageId, reps: null, weightKg: null, status: 'blank', ...(toFailure ? { toFailure: true } : {}) };
}
function buildExercise(form) {
  const stages = [
    stage(form + '-d1', '默认阶段1', 20, 8, 12, false, 15),
    stage(form + '-d2', '默认阶段2', 15, 8, 12, false, 20),
    stage(form + '-d3', '默认阶段3', 10, null, null, true),
  ];
  const round2 = [
    stage(form + '-r2a', '第二轮阶段A', 18, 6, 10, false, 25),
    stage(form + '-r2b', '第二轮阶段B', 12, 10, 15, true),
  ];
  const target = {
    kind: 'dropSet',
    form: form === 'superset' ? 'superset' : 'dropSet',
    rounds: 2,
    stages,
    roundConfigs: [{ roundIndex: 2, stages: round2 }],
    restInSec: 15,
    restAfterSec: 90,
    weightMode: 'external',
  };
  const groups = [{ index: 1, stageCount: 3 }, { index: 2, stageCount: 2 }];
  const sets = [];
  for (let r = 1; r <= 2; r += 1) {
    const need = r === 1 ? 3 : 2;
    const list = r === 1 ? stages : round2;
    for (let s = 1; s <= need; s += 1) sets.push(setRow(form + '-set-' + r + '-' + s, r, s, list[s - 1].id, list[s - 1].toFailure));
  }
  return { target, groups, sets };
}

async function seedSession(plan, day, form) {
  const id = 'r02-fix2-' + form;
  const existing = await getSession(id);
  if (existing) return id;
  const session = createSession(plan, day);
  session.id = id;
  session.exercises = [session.exercises[0]];
  const ex = session.exercises[0];
  const built = buildExercise(form);
  ex.id = 'r02-fix2-ex-' + form;
  ex.name = 'R02FIX2 ' + form;
  ex.exerciseId = 'custom:r02fix2-' + form;
  ex.planExerciseId = null;
  ex.restSec = 90;
  ex.target = built.target;
  ex.groups = built.groups;
  ex.sets = built.sets;
  await atomicCreateSession({ session });
  return id;
}

async function boot() {
  await ensureSeed();
  const plans = await listPlans();
  const plan = plans[0];
  const day = plan.days[0];
  const ids = {};
  ids.superset = await seedSession(plan, day, 'superset');
  ids.dropSet = await seedSession(plan, day, 'dropSet');

  window.__db = {
    getSession,
    listPlans,
    getTemplates: readExerciseTemplates,
  };
  window.__test = {
    ids,
    async navigate(sessionId) {
      navigate('/session/' + sessionId, true);
      await new Promise((r) => setTimeout(r, 200));
    },
  };
  createRoot(document.getElementById('root')).render(
    React.createElement(React.StrictMode, null, React.createElement(StoreProvider, null, React.createElement(App))),
  );
  navigate('/session/' + ids.superset, true);
  window.__booted = true;
}
boot().catch((err) => { window.__bootError = String(err); });
`;
