/**
 * Inter-reviewer agreement.
 * Cohen's kappa compares how often two reviewers agree with how often they
 * would agree by chance: 1 is perfect agreement, 0 is chance level.
 */

export function cohenKappa(a: string[], b: string[]): number | null {
  if (a.length !== b.length) throw new Error('Rating lists must be the same length');
  const n = a.length;
  if (n === 0) return null;

  let agree = 0;
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x === y) agree++;
    countA.set(x, (countA.get(x) ?? 0) + 1);
    countB.set(y, (countB.get(y) ?? 0) + 1);
  }
  const observed = agree / n;
  let expected = 0;
  for (const [label, ca] of countA) {
    expected += (ca / n) * ((countB.get(label) ?? 0) / n);
  }
  // Both reviewers always used the same single label: kappa is undefined.
  if (expected >= 1) return null;
  return (observed - expected) / (1 - expected);
}

export interface VerdictRow {
  taskId: string;
  reviewerId: string;
  verdict: string;
}

export interface PairAgreement {
  reviewerA: string;
  reviewerB: string;
  sharedTasks: number;
  percentAgreement: number;
  kappa: number | null;
}

export function pairwiseAgreement(rows: VerdictRow[]): { pairs: PairAgreement[]; averageKappa: number | null } {
  const byReviewer = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (!byReviewer.has(r.reviewerId)) byReviewer.set(r.reviewerId, new Map());
    byReviewer.get(r.reviewerId)!.set(r.taskId, r.verdict);
  }
  const ids = [...byReviewer.keys()].sort();
  const pairs: PairAgreement[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const ra = byReviewer.get(ids[i] as string)!;
      const rb = byReviewer.get(ids[j] as string)!;
      const a: string[] = [];
      const b: string[] = [];
      for (const [taskId, verdict] of ra) {
        const other = rb.get(taskId);
        if (other !== undefined) {
          a.push(verdict);
          b.push(other);
        }
      }
      if (a.length === 0) continue;
      const same = a.filter((v, k) => v === b[k]).length;
      pairs.push({
        reviewerA: ids[i] as string,
        reviewerB: ids[j] as string,
        sharedTasks: a.length,
        percentAgreement: Math.round((same / a.length) * 1000) / 10,
        kappa: cohenKappa(a, b),
      });
    }
  }
  const defined = pairs.map((p) => p.kappa).filter((k): k is number => k !== null);
  const averageKappa = defined.length ? defined.reduce((s, k) => s + k, 0) / defined.length : null;
  return { pairs, averageKappa };
}

export function interpretKappa(k: number | null): string {
  if (k === null) return 'not enough variation to measure';
  if (k >= 0.8) return 'strong agreement';
  if (k >= 0.6) return 'acceptable agreement';
  if (k >= 0.4) return 'moderate agreement';
  return 'weak agreement: review the guidelines';
}
