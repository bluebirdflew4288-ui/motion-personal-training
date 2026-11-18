/* 动作库领域函数（G1，UI 由 G2 接入）。
   ── 边界 ────────────────────────────────────────────────────
   · 合并内置库与用户动作配置记忆，按**稳定动作身份 exerciseId** 去重；
   · 同名/前后空格/内置名重复只保留一条（记忆优先，因为带完整配置）；
   · 中文按拼音排序：使用 Intl.Collator('zh-Hans-u-co-pinyin')，
     不引入新依赖，Node/Chrome 均有完整 ICU；
   · 搜索只匹配**中文名（规范化后包含）/英文名/分组**；拼音仅用于排序（Intl.Collator），
     不做拼音转写、首字母检索或智能分类（R09 明确不新增此类依赖）；
   · 纯函数，不读写存储。 */

import type { ExerciseTemplate } from './types';
import { exerciseIdFromName, normalizeExerciseName } from './identity';
import { pinyinMatchRank } from './pinyinInitials';
import { EXERCISE_LIBRARY, type LibraryEntry } from './presets/library';

export interface ExerciseCatalogEntry {
  /** 稳定动作身份（内置动作走显式预设映射，自定义走规范化名称） */
  exerciseId: string;
  name: string;
  en?: string;
  group?: LibraryEntry['group'];
  /** 常见俗称 / 简称（来自内置库，用于检索召回） */
  aliases?: string[];
  /** 是否来自内置动作库 */
  builtin: boolean;
  /** 是否有已记住的完整配置（模板记忆） */
  hasTemplate: boolean;
  /** 记忆 revision（无记忆 = null） */
  templateRevision: number | null;
}

/** 拼音排序比较器（唯一真源；中文/英文/数字混排稳定） */
const PINYIN_COLLATOR = new Intl.Collator('zh-Hans-u-co-pinyin', {
  numeric: true,
  sensitivity: 'base',
});

export function compareExerciseNames(a: string, b: string): number {
  return PINYIN_COLLATOR.compare(a, b);
}

/** 按动作名拼音首字母顺序排序（稳定：同名再按 exerciseId） */
export function sortExerciseCatalog(entries: ExerciseCatalogEntry[]): ExerciseCatalogEntry[] {
  return [...entries].sort((a, b) => {
    const byName = compareExerciseNames(a.name, b.name);
    if (byName !== 0) return byName;
    return a.exerciseId < b.exerciseId ? -1 : a.exerciseId > b.exerciseId ? 1 : 0;
  });
}

/**
 * 合并内置库与动作配置记忆。
 * 去重键 = exerciseId（稳定身份）；记忆条目优先保留（含完整配置）。
 * 同次训练多个实例不在这里合并——实例由 SessionExercise.id 区分。
 */
export function mergeExerciseCatalog(
  builtin: LibraryEntry[] = EXERCISE_LIBRARY,
  templates: ExerciseTemplate[] = [],
): ExerciseCatalogEntry[] {
  const byId = new Map<string, ExerciseCatalogEntry>();

  for (const item of builtin) {
    const id = exerciseIdFromName(item.name);
    if (byId.has(id)) continue;
    byId.set(id, {
      exerciseId: id,
      name: item.name.trim(),
      ...(item.en ? { en: item.en } : {}),
      group: item.group,
      ...(item.aliases?.length ? { aliases: item.aliases } : {}),
      builtin: true,
      hasTemplate: false,
      templateRevision: null,
    });
  }

  for (const tpl of templates) {
    const id = tpl.exerciseId;
    const prev = byId.get(id);
    byId.set(id, {
      exerciseId: id,
      name: tpl.name.trim(),
      ...(tpl.en ? { en: tpl.en } : prev?.en ? { en: prev.en } : {}),
      ...(prev?.group ? { group: prev.group } : {}),
      ...(prev?.aliases?.length ? { aliases: prev.aliases } : {}),
      builtin: prev?.builtin ?? false,
      hasTemplate: true,
      templateRevision: tpl.revision,
    });
  }

  return sortExerciseCatalog([...byId.values()]);
}

/**
 * 搜索动作库（按名称 / 拼音全拼与不完整音节前缀 / 拼音首字母 / 俗称别名 / 英文名 / 分组）。
 * 空查询返回全部（已按拼音排序）。
 * 命中结果按相关度分层（名称直接命中 > 动作名句首拼音命中 > 动作名句中拼音命中 > 别名命中 > 分组/英文词首 > 英文子串），
 * 同层内保持稳定拼音序，确保输入 `Yin` 时「引体向上」排在最前而非英文含 `yin`（如 `LYING`）的动作。
 */
export function searchExerciseCatalog(entries: ExerciseCatalogEntry[], query: string): ExerciseCatalogEntry[] {
  const raw = query.trim();
  if (!raw) return entries;
  const key = normalizeExerciseName(raw);
  const lower = raw.toLowerCase();

  const scored: Array<{ entry: ExerciseCatalogEntry; tier: number; idx: number }> = [];
  entries.forEach((e, idx) => {
    const normName = normalizeExerciseName(e.name);
    let tier = 99;
    if (normName.startsWith(key)) {
      tier = 0;
    } else if (normName.includes(key)) {
      tier = 1;
    } else {
      const nameRank = pinyinMatchRank(e.name, raw);
      const aliasBestRank = e.aliases?.length
        ? Math.min(
            ...e.aliases.map((alias) => {
              if (normalizeExerciseName(alias).includes(key)) return 0;
              const r = pinyinMatchRank(alias, raw);
              return r >= 0 ? r + 1 : 99;
            }),
          )
        : 99;
      if (nameRank === 0) {
        tier = 2;
      } else if (nameRank === 1 || aliasBestRank <= 1) {
        tier = 3;
      } else if (nameRank === 2) {
        tier = 4;
      } else if (nameRank === 3 || aliasBestRank < 99) {
        tier = 5;
      } else if (e.group && e.group.includes(raw)) {
        tier = 6;
      } else if (e.en) {
        const enLower = e.en.toLowerCase();
        const words = enLower.split(/[\s/-]+/);
        if (words.some((w) => w.startsWith(lower))) {
          tier = 7;
        } else if (enLower.includes(lower)) {
          tier = 8;
        }
      }
    }
    if (tier < 99) {
      scored.push({ entry: e, tier, idx });
    }
  });

  scored.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.idx - b.idx));
  return scored.map((s) => s.entry);
}

/** 由模板记忆生成合并目录（便捷入口，UI G2 可直接调用） */
export function catalogFromTemplates(templates: ExerciseTemplate[]): ExerciseCatalogEntry[] {
  return mergeExerciseCatalog(EXERCISE_LIBRARY, templates);
}
