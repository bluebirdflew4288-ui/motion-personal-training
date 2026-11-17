/**
 * G2A 真实 DOM 挂载入口：导入**实际 ExerciseEditor 组件**。
 * R6 修正：
 *  · initial.key 真实传入（组件据它判断「同一编辑对象」与「切到另一个编辑对象」）；
 *  · 每个用例可重置 submitMode / pending / counters；
 *  · 覆盖同名 instance remount 与同实例 initial.key 变化两种 B 切换；
 *  · 暴露 applyTargetToExercise 联测旧 actual 是否保住。
 * 样式由外部 /style.css 注入（真实 tokens/base/zine），本入口不 import CSS。
 */

export const g2aEntry = `
import React, { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExerciseEditor } from './src/ui/ExerciseEditor';
import { applyTargetToExercise } from './src/domain/exerciseConfig';
import { restAfterSet } from './src/domain/session';
import { backStack } from './src/lib/backIntent';

function stage(id, label, weightKg, repsMin, repsMax, toFailure, restAfterSec) {
  return {
    label,
    weightKg,
    repsMin,
    repsMax,
    toFailure,
    targetText: '',
    ...(id ? { id } : {}),
    ...(restAfterSec === undefined ? {} : { restAfterSec }),
  };
}

function multiTarget(kind) {
  if (kind === 'legacy') {
    // 旧数据：无阶段 id、无逐阶段休息、末阶段力竭且参考次数为空
    return {
      kind: 'dropSet', rounds: 2,
      stages: [
        stage(null, '第 1 阶段', 20, 8, 12, false),
        stage(null, '第 2 阶段', 15, 8, 12, true),
        stage(null, '第 3 阶段', 10, null, null, true),
      ],
      restInSec: 15, restAfterSec: 90, weightMode: 'assisted', dumbbellBasis: 'per_hand',
    };
  }
  if (kind === 'eight') {
    return {
      kind: 'dropSet', rounds: 1,
      stages: Array.from({ length: 8 }, (_, i) => stage(null, '阶段' + (i + 1), 10, i === 2 ? null : 8, i === 2 ? null : 12, i === 2)),
      restInSec: 15, restAfterSec: 90, weightMode: 'external',
    };
  }
  return {
    kind: 'dropSet', rounds: 2,
    stages: [
      stage('g2a-s1', '上半程', 20, 8, 12, false, 15),
      stage('g2a-s2', '下半程', 15, 8, 12, true, 20),
      stage('g2a-s3', '全程', 10, null, null, true),
    ],
    restInSec: 15, restAfterSec: 90, weightMode: 'assisted', dumbbellBasis: 'per_hand',
  };
}

function straightTarget() {
  return {
    kind: 'straight', sets: 3, setsMax: 3, repsMin: 8, repsMax: 12,
    weightMode: 'assisted', suggestedWeightKg: 60, dumbbellBasis: 'per_hand',
  };
}

function arranged(count, stageCount) {
  return Array.from({ length: count }, (_, i) => ({ index: i + 1, stageCount: stageCount || 1 }));
}

function makeInitial(caseName, keyOverride) {
  const key = keyOverride || caseName;
  const base = { memory: { mode: 'none', revision: null } };
  if (caseName === 'multi' || caseName === 'legacy' || caseName === 'eight') {
    const kind = caseName === 'multi' ? 'explicit' : caseName;
    const target = multiTarget(kind);
    return {
      ...base, key, name: caseName === 'legacy' ? '动作A' : '哑铃侧平举',
      exerciseId: caseName === 'legacy' ? 'custom:a' : 'lib-lateral-raise',
      target, restSec: 90,
      arrangedGroups: arranged(1, target.stages.length),
      memory: caseName === 'legacy' ? { mode: 'none', revision: null } : { mode: 'exists', revision: 2 },
    };
  }
  if (caseName === 'straight4') {
    return { ...base, key, name: '自由杠铃卧推', exerciseId: 'lib-barbell-bench', target: straightTarget(), restSec: 120, arrangedGroups: arranged(4), memory: { mode: 'first', revision: null } };
  }
  if (caseName === 'a') return { ...base, key, name: '动作A', exerciseId: 'custom:a', target: straightTarget(), restSec: 120, arrangedGroups: arranged(3) };
  if (caseName === 'b') return { ...base, key, name: '动作B', exerciseId: 'custom:b', target: straightTarget(), restSec: 120, arrangedGroups: arranged(3) };
  if (caseName === 'long') {
    return { ...base, key, name: '超长动作名称'.repeat(30), exerciseId: 'custom:' + '超长动作名称'.repeat(30), target: multiTarget('explicit'), restSec: 90, arrangedGroups: arranged(1, 3) };
  }
  return { ...base, key, name: '动作', exerciseId: 'custom:x', target: straightTarget(), restSec: 120, arrangedGroups: arranged(3) };
}

function Harness() {
  const [value, setValue] = useState({ initial: makeInitial('__closed__'), open: false, instance: 0 });
  const [, setTick] = useState(0);
  const calls = useRef([]);
  const closes = useRef([]);
  const pending = useRef([]);
  const tickOn = useRef(false);
  const originRef = useRef(value.initial.key);
  originRef.current = value.initial.key;

  useEffect(() => {
    const id = setInterval(() => { if (tickOn.current) setTick((t) => t + 1); }, 30);
    return () => clearInterval(id);
  }, []);

  window.__audit = {
    open(caseName, remount) {
      setValue((v) => ({ initial: makeInitial(caseName), open: true, instance: v.instance + (remount ? 1 : 0) }));
    },
    /** 同实例只换 initial.key（不 remount） */
    switchKey(caseName) {
      setValue((v) => ({ ...v, initial: makeInitial(caseName) }));
    },
    hide() { setValue((v) => ({ ...v, open: false })); },
    tick(on) { tickOn.current = on; },
    setMode(mode) { window.__submitMode = mode; },
    reset(mode) { calls.current = []; closes.current = []; pending.current = []; window.__submitMode = mode || 'ok'; },
    resolve(result) { const r = pending.current.shift(); if (!r) throw new Error('no pending'); r(result); },
    calls() { return calls.current.map((c) => ({ origin: c.origin, payload: c.payload })); },
    closes() { return closes.current.slice(); },
    pendingCount() { return pending.current.length; },
    openCase() { return value.open ? value.initial.key : null; },
    apply(payload) {
      const ex = {
        id: 'ex1', exerciseId: 'custom:a', name: '动作A', restSec: 90,
        target: multiTarget('legacy'), status: 'pending', groups: [{ index: 1, stageCount: 3 }],
        sets: [1, 2, 3].map((i) => ({ id: 'actual-' + i, roundIndex: 1, stageIndex: i, reps: 10 + i, weightKg: 20 + i, status: 'done' })),
      };
      return applyTargetToExercise(ex, payload.target);
    },
    snapshotRest() {
      const ex = { target: multiTarget('legacy'), restSec: 90, groups: [{ index: 1, stageCount: 2 }] };
      return [restAfterSet(ex, { roundIndex: 1, stageIndex: 1 }), restAfterSet(ex, { roundIndex: 1, stageIndex: 2 })];
    },
    backDepth() { return backStack.depth; },
  };

  function onSubmit(payload) {
    calls.current.push({ origin: originRef.current, payload: structuredClone(payload) });
    const mode = window.__submitMode || 'ok';
    if (mode === 'fail') return Promise.resolve({ ok: false, message: '注入保存失败' });
    if (mode === 'manual') return new Promise((r) => pending.current.push(r));
    return Promise.resolve({ ok: true });
  }

  return React.createElement(ExerciseEditor, {
    key: value.instance,
    open: value.open,
    mode: 'edit',
    initial: value.initial,
    templates: [],
    onSubmit,
    onClose() {
      closes.current.push(originRef.current);
      setValue((v) => ({ ...v, open: false }));
    },
  });
}

createRoot(document.getElementById('root')).render(
  __AUDIT_STRICT__ ? React.createElement(StrictMode, null, React.createElement(Harness)) : React.createElement(Harness),
);
`;

export const g2aExistingEntry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './src/store';
import { App } from './src/App';
import { ensureSeed, listPlans, getSession } from './src/db/repo';
import { createSession, restAfterSet } from './src/domain/session';
import { atomicCreateSession } from './src/db/tx';
import { navigate } from './src/lib/router';
import { readExerciseTemplates, putExerciseTemplate } from './src/db/templates';

async function boot() {
  await ensureSeed();
  const plan = (await listPlans())[0];
  const session = createSession(plan, plan.days[0]);
  session.id = 'g2a-existing-session';
  // 追加一个真实 3 阶段多阶段动作（末阶段力竭 + null 参考次数）用于卡片/编辑器联测
  const stages = [
    { id: 'g2b-s1', label: '上半程', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, restAfterSec: 15, targetText: '' },
    { id: 'g2b-s2', label: '下半程', weightKg: 15, repsMin: 8, repsMax: 12, toFailure: true, restAfterSec: 20, targetText: '' },
    { id: 'g2b-s3', label: '全程', weightKg: 10, repsMin: null, repsMax: null, toFailure: true, targetText: '' },
  ];
  const sets = stages.map((_, i) => ({ id: 'g2b-set-' + (i + 1), roundIndex: 1, stageIndex: i + 1, stageId: 'g2b-s' + (i + 1), reps: i === 0 ? 11 : i === 1 ? 12 : null, weightKg: i === 0 ? 20 : i === 1 ? 15 : null, status: i === 0 || i === 1 ? 'done' : 'blank' }));
  session.exercises.unshift({
    id: 'g2b-multi', exerciseId: 'custom:g2b-multi', planExerciseId: null,
    name: '三阶段测试', restSec: 90,
    target: { kind: 'dropSet', rounds: 1, stages, restInSec: 15, restAfterSec: 90, weightMode: 'external' },
    status: 'pending', groups: [{ index: 1, stageCount: 3 }], sets,
  });
  const created = await atomicCreateSession({ session });
  if (!created.ok) throw new Error('seed session failed');
  window.__db = {
    getSession,
    listPlans,
    getTemplates: readExerciseTemplates,
    putTemplate: putExerciseTemplate,
    restFor: async (exId, stageIndex) => {
      const s = await getSession('g2a-existing-session');
      const ex = s && s.exercises.find((e) => e.id === exId);
      const set = ex && ex.sets.find((x) => x.roundIndex === 1 && x.stageIndex === stageIndex);
      return ex && set ? restAfterSet(ex, set) : null;
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
