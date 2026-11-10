import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { toCsv, csvCell } from '../src/lib/csv.js';
import { cohenKappa, interpretKappa, pairwiseAgreement } from '../src/lib/kappa.js';
import { hashToken, newRefreshToken, signAccessToken, verifyAccessToken } from '../src/lib/tokens.js';
import { camelize } from '../src/app.js';
import { registerBody, reviewBody, tasksBody } from '../src/schemas.js';

describe('cohenKappa', () => {
  it('is 1 for perfect agreement with more than one label', () => {
    expect(cohenKappa(['pass', 'fail', 'pass', 'fail'], ['pass', 'fail', 'pass', 'fail'])).toBe(1);
  });

  it('is 0 when agreement is only what chance would give', () => {
    // A says pass,pass,fail,fail; B says pass,fail,pass,fail -> 50% agreement, 50% expected
    expect(cohenKappa(['pass', 'pass', 'fail', 'fail'], ['pass', 'fail', 'pass', 'fail'])).toBeCloseTo(0, 10);
  });

  it('is negative when reviewers systematically disagree', () => {
    expect(cohenKappa(['pass', 'fail', 'pass', 'fail'], ['fail', 'pass', 'fail', 'pass'])).toBeLessThan(0);
  });

  it('matches a hand-worked example', () => {
    // 10 items: both pass 4, both fail 3, A pass/B fail 2, A fail/B pass 1
    const a = [...Array(4).fill('pass'), ...Array(3).fill('fail'), ...Array(2).fill('pass'), 'fail'];
    const b = [...Array(4).fill('pass'), ...Array(3).fill('fail'), ...Array(2).fill('fail'), 'pass'];
    // observed 0.7; A pass 0.6, B pass 0.5 -> expected 0.6*0.5 + 0.4*0.5 = 0.5; kappa = 0.2/0.5 = 0.4
    expect(cohenKappa(a, b)).toBeCloseTo(0.4, 10);
  });

  it('returns null when it is undefined', () => {
    expect(cohenKappa([], [])).toBeNull();
    expect(cohenKappa(['pass', 'pass'], ['pass', 'pass'])).toBeNull();
  });

  it('rejects lists of different length', () => {
    expect(() => cohenKappa(['pass'], [])).toThrow();
  });
});

describe('pairwiseAgreement', () => {
  it('compares only the tasks both reviewers rated', () => {
    const rows = [
      { taskId: 't1', reviewerId: 'a', verdict: 'pass' },
      { taskId: 't2', reviewerId: 'a', verdict: 'fail' },
      { taskId: 't3', reviewerId: 'a', verdict: 'pass' },
      { taskId: 't1', reviewerId: 'b', verdict: 'pass' },
      { taskId: 't2', reviewerId: 'b', verdict: 'fail' },
      { taskId: 't9', reviewerId: 'b', verdict: 'fail' },
    ];
    const { pairs, averageKappa } = pairwiseAgreement(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ sharedTasks: 2, percentAgreement: 100, kappa: 1 });
    expect(averageKappa).toBe(1);
  });

  it('returns no pairs for a single reviewer', () => {
    expect(pairwiseAgreement([{ taskId: 't1', reviewerId: 'a', verdict: 'pass' }])).toEqual({ pairs: [], averageKappa: null });
  });
});

describe('interpretKappa', () => {
  it.each([
    [0.9, 'strong'],
    [0.7, 'acceptable'],
    [0.5, 'moderate'],
    [0.1, 'weak'],
    [null, 'not enough'],
  ])('describes %s', (k, word) => {
    expect(interpretKappa(k as number | null)).toContain(word);
  });
});

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toMatch(/^"'=/);
    expect(csvCell('+1+1')).toBe("'+1+1");
  });

  it('builds a document with a header', () => {
    expect(toCsv(['a', 'b'], [[1, null]])).toBe('a,b\n1,\n');
  });
});

describe('tokens', () => {
  const config = loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'a-long-enough-test-secret' });

  it('round-trips an access token', () => {
    const t = signAccessToken(config, { sub: 'u1', role: 'admin', email: 'a@b.co' });
    expect(verifyAccessToken(config, t)).toEqual({ sub: 'u1', role: 'admin', email: 'a@b.co' });
  });

  it('rejects a token signed with another secret', () => {
    const other = loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'a-different-long-secret!!' });
    const t = signAccessToken(other, { sub: 'u1', role: 'admin', email: 'a@b.co' });
    expect(() => verifyAccessToken(config, t)).toThrow();
  });

  it('stores only a hash of refresh tokens', () => {
    const { token, hash } = newRefreshToken();
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
  });
});

describe('config', () => {
  it('fails fast on a short JWT secret', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ JWT_SECRET: 'a-long-enough-test-secret' })).toThrow(/DATABASE_URL/);
  });
});

describe('validation schemas', () => {
  it('normalises the email and enforces password rules', () => {
    expect(registerBody.parse({ email: '  A@B.CO ', name: 'A', password: 'abcdefghij1' }).email).toBe('a@b.co');
    expect(() => registerBody.parse({ email: 'a@b.co', name: 'A', password: 'short1' })).toThrow();
    expect(() => registerBody.parse({ email: 'a@b.co', name: 'A', password: 'onlyletterspassword' })).toThrow();
  });

  it('keeps ratings in range', () => {
    expect(() => reviewBody.parse({ rating: 0, verdict: 'pass' })).toThrow();
    expect(() => reviewBody.parse({ rating: 6, verdict: 'pass' })).toThrow();
    expect(() => reviewBody.parse({ rating: 3, verdict: 'maybe' })).toThrow();
    expect(reviewBody.parse({ rating: 3, verdict: 'pass' }).notes).toBe('');
  });

  it('limits bulk task creation', () => {
    expect(() => tasksBody.parse({ tasks: [] })).toThrow();
    const many = Array.from({ length: 101 }, () => ({ prompt: 'p', response: 'r' }));
    expect(() => tasksBody.parse({ tasks: many })).toThrow();
  });
});

describe('camelize', () => {
  it('converts nested snake_case keys and leaves dates alone', () => {
    const d = new Date();
    expect(camelize({ task_count: 1, nested: [{ done_at: d }] })).toEqual({ taskCount: 1, nested: [{ doneAt: d }] });
  });
});
