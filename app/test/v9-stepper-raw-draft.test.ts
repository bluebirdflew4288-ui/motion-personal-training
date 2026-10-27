import { describe, expect, it } from 'vitest';
import { isUnfinishedNumberDraft } from '../src/ui/Stepper';

describe('v9 raw numeric draft lifecycle contract', () => {
  it('retains empty, dot, and trailing-decimal text until completed or explicitly discarded', () => {
    expect(isUnfinishedNumberDraft('')).toBe(true);
    expect(isUnfinishedNumberDraft('.')).toBe(true);
    expect(isUnfinishedNumberDraft('7.')).toBe(true);
    expect(isUnfinishedNumberDraft('7.5')).toBe(false);
    expect(isUnfinishedNumberDraft('0')).toBe(false);
  });
});
