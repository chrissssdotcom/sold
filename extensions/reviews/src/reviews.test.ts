import { describe, expect, it } from 'vitest';
import { cleanText, moderationInput, reviewInput, roundAverage } from './input';

describe('review input', () => {
  it('accepts a normal review and trims it', () => {
    const r = reviewInput.parse({
      rating: 5,
      title: '  Lovely ',
      body: '  Burns slowly.  ',
      authorName: ' Sam   B ',
    });
    expect(r).toEqual({ rating: 5, title: 'Lovely', body: 'Burns slowly.', authorName: 'Sam B' });
  });
  it('rejects out-of-range ratings, empty bodies, oversize text and unknown keys', () => {
    for (const bad of [
      { rating: 0, body: 'x' },
      { rating: 6, body: 'x' },
      { rating: 4.5, body: 'x' },
      { rating: 5, body: '   ' },
      { rating: 5, body: 'x'.repeat(4001) },
      { rating: 5, body: 'ok', title: 'x'.repeat(121) },
      { rating: 5, body: 'ok', status: 'approved' }, // a customer can never choose their own status
      { rating: 5, body: 'ok', customerId: 'someone-else' },
    ])
      expect(reviewInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it('strips control characters but keeps normal line breaks', () => {
    expect(cleanText('a\u0000b\u0007c\nd')).toBe('abc\nd');
    expect(cleanText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
  it('moderation only allows approved or rejected (never back to pending)', () => {
    expect(moderationInput.safeParse({ status: 'approved' }).success).toBe(true);
    expect(moderationInput.safeParse({ status: 'pending' }).success).toBe(false);
  });
  it('averages to one decimal and never divides by zero', () => {
    expect(roundAverage(0, 0)).toBe(0);
    expect(roundAverage(14, 3)).toBe(4.7);
  });
});
