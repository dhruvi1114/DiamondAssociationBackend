import { describe, expect, it } from 'vitest';

import { excerpt } from '@modules/event/event.service';

/**
 * The description an event card carries.
 *
 * The rule worth protecting is the ellipsis: it is a promise that there is more
 * to read, so it may only appear when something was actually left behind.
 */
describe('excerpt', () => {
  it('has nothing to say about an empty description', () => {
    expect(excerpt(null)).toBeNull();
    expect(excerpt('')).toBeNull();
    expect(excerpt('   \n  ')).toBeNull();
  });

  it('returns a short description whole, with no ellipsis', () => {
    expect(excerpt('Two days of keynotes.')).toBe('Two days of keynotes.');
  });

  /** A textarea's newlines are not layout a card can honour. */
  it('collapses the whitespace an admin typed', () => {
    expect(excerpt('Two days\n\nof   keynotes.')).toBe('Two days of keynotes.');
  });

  it('cuts on a word, never mid-word', () => {
    const text = `${'word '.repeat(60)}tail`;
    const result = excerpt(text);

    expect(result).not.toBeNull();
    expect(result).toMatch(/…$/);
    expect(result).not.toMatch(/wor…$/);
    expect(result?.length).toBeLessThanOrEqual(181);
  });

  it('does not leave a comma or full stop sitting against the ellipsis', () => {
    const text = `${'alpha, '.repeat(40)}end`;

    expect(excerpt(text)).not.toMatch(/[,.]…$/);
  });

  /** A description one character too long must not gain an ellipsis for it. */
  it('adds no ellipsis when nothing was left behind', () => {
    const exact = 'a'.repeat(180);

    expect(excerpt(exact)).toBe(exact);
    expect(excerpt(exact)).not.toMatch(/…$/);
  });
});
