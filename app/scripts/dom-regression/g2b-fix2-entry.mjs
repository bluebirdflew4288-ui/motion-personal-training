/**
 * G2B-FIX2 真实 App 集成入口：实际 SessionPage + ExerciseEditor + 隔离 IndexedDB。
 * 每个 browser context 独立 boot；fixture 只使用合成数据，不读用户真实库。
 */
export const g2bFix2Entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './src/store';
import { App } from './src/App';
import { ensureSeed, listPlans, getSession } from './src/db/repo';
import { createSession, restAfterSet, exerciseCompletion } from './src/domain/session';
import { atomicCreateSession } from './src/db/tx';
import { navigate } from './src/lib/router';
import { readExerciseTemplates } from './src/db/templates';

function blankSet(id, roundIndex, stageIndex, toFailure) {
  return { id, roundIndex, stageIndex, reps: null, weightKg: null, status: 'blank', ...(toFailure ? { toFailure: true } : {}) };
}
function stage(label, weightKg, repsMin, repsMax, toFailure, restAfterSec) {
  return { label, weightKg, repsMin, repsMax, toFailure, targetText: '', ...(restAfterSec === undefined ? {} : { restAfterSec }) };
}

async function boot() {
  await ensureSeed();
  const plans = await listPlans();
  const plan = plans[0];
  const day = plan.days[0];

  // 1) 默认训练：3 阶段 multi + 普通卧推
  const session = createSession(plan, day);
  session.id = 'g2a-existing-session';
  const stages = [
    stage('上半程', 20, 8, 12, false, 15),
    stage('下半程', 15, 8, 12, true, 20),
    stage('全程', 10, null, null, true),
  ];
  const sets = stages.map((_, i) => ({
    id: 'g2b-set-' + (i + 1), roundIndex: 1, stageIndex: i + 1, stageId: 'g2b-s' + (i + 1),
    reps: i === 0 ? 11 : i === 1 ? 12 : null,
    weightKg: i === 0 ? 20 : i === 1 ? 15 : null,
    status: i === 0 || i === 1 ? 'done' : 'blank',
  }));
  session.exercises.unshift({
    id: 'g2b-multi', exerciseId: 'custom:g2b-multi', planExerciseId: null,
    name: '三阶段测试', restSec: 90,
    target: { kind: 'dropSet', rounds: 1, stages, restInSec: 15, restAfterSec: 90, weightMode: 'external' },
    status: 'pending', groups: [{ index: 1, stageCount: 3 }], sets,
  });
  const rootFour = structuredClone(session.exercises[0]);
  rootFour.id = 'root-four'; rootFour.name = '根四轮'; rootFour.target.rounds = 3;
  rootFour.groups = Array.from({ length: 4 }, (_, i) => ({ index: i + 1, stageCount: 3 }));
  rootFour.sets = rootFour.groups.flatMap((g) => rootFour.target.stages.map((st, i) => ({ id: 'root-four-' + g.index + '-' + i, roundIndex: g.index, stageIndex: i + 1, stageId: st.id, reps: null, weightKg: null, status: 'blank' })));
  session.exercises.push(rootFour);
  const rootThree = structuredClone(session.exercises.find((e) => e.target.kind === 'straight' && e.sets.length === 3));
  rootThree.id = 'root-three'; rootThree.name = '根三组';
  rootThree.sets = rootThree.sets.map((s, i) => ({ ...s, id: 'root-three-' + i, reps: i < 2 ? 10 : null, weightKg: i < 2 ? 60 : null, status: i < 2 ? 'done' : 'blank' }));
  session.exercises.push(rootThree);
  await atomicCreateSession({ session });

  // 2) 身份测试：非 null planExerciseId + actual 的普通动作
  const ids = createSession(plan, day);
  ids.id = 'g2b-identity-session';
  const ie = ids.exercises[0];
  ie.id = 'identity-ex';
  ie.name = '杠铃卧推原动作';
  ie.exerciseId = 'lib-barbell-bench';
  ie.planExerciseId = 'pe-identity-1';
  ie.restSec = 120;
  ie.target = { kind: 'straight', sets: 3, setsMax: 3, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 60 };
  ie.groups = [1, 2, 3].map((i) => ({ index: i, stageCount: 1 }));
  ie.sets = [1, 2, 3].map((i) => ({
    id: 'identity-set-' + i, roundIndex: i, stageIndex: 1,
    reps: i <= 2 ? 8 : null, weightKg: i <= 2 ? 60 : null, status: i <= 2 ? 'done' : 'blank',
  }));
  await atomicCreateSession({ session: ids });

  // 2b) 身份测试：自定义 normalized identity + actual（同一规范化名称）
  const idc = createSession(plan, day);
  idc.id = 'g2b-identity-custom-session';
  const ice = idc.exercises[0];
  ice.id = 'identity-custom-ex';
  ice.name = '卧推自定';
  ice.exerciseId = 'custom:卧推自定';
  ice.planExerciseId = 'pe-identity-custom';
  ice.restSec = 120;
  ice.target = { kind: 'straight', sets: 3, setsMax: 3, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 40 };
  ice.groups = [1, 2, 3].map((i) => ({ index: i, stageCount: 1 }));
  ice.sets = [1, 2, 3].map((i) => ({
    id: 'identity-custom-set-' + i, roundIndex: i, stageIndex: 1,
    reps: i <= 2 ? 10 : null, weightKg: i <= 2 ? 40 : null, status: i <= 2 ? 'done' : 'blank',
  }));
  await atomicCreateSession({ session: idc });

  // 3) 目标 3 轮、当前结构 4 轮
  const four = createSession(plan, day);
  four.id = 'g2b-four-session';
  const fe = four.exercises[0];
  fe.id = 'four-ex';
  fe.name = '四轮结构测试';
  fe.exerciseId = 'custom:four';
  fe.planExerciseId = null;
  fe.restSec = 90;
  fe.target = { kind: 'dropSet', rounds: 3, stages: [stage('上', 10, null, null, false), stage('中', 8, null, null, true), stage('下', 6, null, null, true)], restInSec: 15, restAfterSec: 90, weightMode: 'external' };
  fe.groups = [1, 2, 3, 4].map((i) => ({ index: i, stageCount: 3 }));
  fe.sets = [];
  for (let r = 1; r <= 4; r += 1) for (let s = 1; s <= 3; s += 1) fe.sets.push(blankSet('four-set-' + r + '-' + s, r, s));
  await atomicCreateSession({ session: four });

  // 4) 3 组已做 2 组，第 3 组空白：删空组后动作按 2 组完成
  const del = createSession(plan, day);
  del.id = 'g2b-delete-session';
  const de = del.exercises[0];
  de.id = 'delete-ex';
  de.name = '三组删空测试';
  de.exerciseId = 'custom:delete';
  de.planExerciseId = null;
  de.restSec = 120;
  de.target = { kind: 'straight', sets: 3, setsMax: 3, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 40 };
  de.groups = [1, 2, 3].map((i) => ({ index: i, stageCount: 1 }));
  de.sets = [1, 2, 3].map((i) => ({
    id: 'delete-set-' + i, roundIndex: i, stageIndex: 1,
    reps: i <= 2 ? 10 : null, weightKg: i <= 2 ? 40 : null, status: i <= 2 ? 'done' : 'blank',
  }));
  await atomicCreateSession({ session: del });

  window.__db = {
    getSession,
    listPlans,
    getTemplates: readExerciseTemplates,
    restFor: async (exId, stageIndex) => {
      const s = await getSession('g2a-existing-session');
      const ex = s && s.exercises.find((e) => e.id === exId);
      const set = ex && ex.sets.find((x) => x.roundIndex === 1 && x.stageIndex === stageIndex);
      return ex && set ? restAfterSet(ex, set) : null;
    },
    completionFor: async (sessionId, exId) => {
      const s = await getSession(sessionId);
      const ex = s && s.exercises.find((e) => e.id === exId);
      return ex ? exerciseCompletion(ex) : null;
    },
  };
  window.__test = {
    async navigate(sessionId) {
      navigate('/session/' + sessionId, true);
      await new Promise((r) => setTimeout(r, 180));
    },
  };
  createRoot(document.getElementById('root')).render(
    React.createElement(React.StrictMode, null, React.createElement(StoreProvider, null, React.createElement(App))),
  );
  navigate('/session/' + session.id, true);
  window.__booted = true;
}
boot().catch((err) => { window.__bootError = String(err); });
`;
