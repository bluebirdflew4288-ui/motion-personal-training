import { setDirtyField } from '../../coach/focusGuard';

const isBlockingDraftField = (drafts: Map<string, string> | undefined, fid: string): boolean => {
  if (!drafts?.has(fid)) return true;
  return drafts.get(fid) !== '';
};

/** 仅当存在非空/未成型草稿文本时阻断提交或沿用（空串代表已显式清空，不作阻断）。 */
export function hasNonEmptyRawDraftInMaps(
  rawRiskMap: Map<string, Set<string>>,
  rawDraftMap: Map<string, Map<string, string>>,
  exId?: string,
): boolean {
  const check = (id: string) => {
    const drafts = rawDraftMap.get(id);
    const risk = rawRiskMap.get(id);
    if (drafts) for (const raw of drafts.values()) if (raw !== '') return true;
    if (risk) for (const fid of risk) if (isBlockingDraftField(drafts, fid)) return true;
    return false;
  };
  if (exId) return check(exId);
  for (const id of rawDraftMap.keys()) if (check(id)) return true;
  for (const id of rawRiskMap.keys()) if (check(id)) return true;
  return false;
}

/** 批量清除指定字段的 raw 草稿、风险登记与焦点守卫 dirty 标记；返回是否有实际变动。 */
export function clearRawFieldsInMaps(
  rawRiskMap: Map<string, Set<string>>,
  rawDraftMap: Map<string, Map<string, string>>,
  exId: string,
  fieldIds: readonly string[],
): boolean {
  if (!fieldIds.length) return false;
  const risk = rawRiskMap.get(exId);
  const drafts = rawDraftMap.get(exId);
  let dirty = false;
  for (const fid of fieldIds) {
    if (risk?.delete(fid)) dirty = true;
    if (drafts?.delete(fid)) dirty = true;
    const [setId, f] = fid.split(':');
    if (setId && (f === 'reps' || f === 'weight')) {
      setDirtyField({ exId, setId, field: f }, false);
    }
  }
  if (risk && !risk.size) rawRiskMap.delete(exId);
  if (drafts && !drafts.size) rawDraftMap.delete(exId);
  return dirty;
}
