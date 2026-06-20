import type { IPathConvention } from './path-convention.ts';

export interface IPathSelection {
  convention: IPathConvention;
  reason: string;
  score: number;
}

export function selectBestPath(
  candidates: readonly IPathConvention[],
  task: string,
): IPathSelection | null {
  if (!candidates || candidates.length === 0) return null;
  if (typeof task !== 'string' || task.trim() === '') return null;
  const taskLower = task.toLowerCase();
  const scored = candidates
    .map((c) => {
      let score = 0;
      const reasons: string[] = [];
      if (c.tags.some((t) => taskLower.includes(t.toLowerCase()))) {
        score += 30;
        reasons.push('tag match');
      }
      if (c.appliesWhen.some((a) => taskLower.includes(a.toLowerCase()))) {
        score += 40;
        reasons.push('appliesWhen match');
      }
      if (c.scope.some((s) => taskLower.includes(s.toLowerCase()))) {
        score += 20;
        reasons.push('scope match');
      }
      if (c.title.toLowerCase().includes(taskLower)) {
        score += 25;
        reasons.push('title overlap');
      }
      return { c, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score === 0) return null;
  return {
    convention: top.c,
    reason: top.reasons.length ? top.reasons.join(', ') : 'baseline match',
    score: top.score,
  };
}
