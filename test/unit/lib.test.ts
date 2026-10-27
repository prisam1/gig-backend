import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { csv, pageRange, parse } from '../../src/lib/http';

describe('csv query helper', () => {
  const schema = csv(z.enum(['A', 'B', 'C']));

  it('splits, trims and de-duplicates comma-separated values', () => {
    expect(schema.parse(' A , B,A ,, C')).toEqual(['A', 'B', 'C']);
  });

  it('accepts repeated query keys', () => {
    expect(schema.parse(['A', 'B,C'])).toEqual(['A', 'B', 'C']);
  });

  it('rejects any invalid item', () => {
    expect(schema.safeParse('A,D').success).toBe(false);
  });
});

describe('pageRange', () => {
  it('converts page and size to a 0-based inclusive range', () => {
    expect(pageRange({ page: 1, pageSize: 20 })).toEqual({ from: 0, to: 19 });
    expect(pageRange({ page: 3, pageSize: 10 })).toEqual({ from: 20, to: 29 });
  });
});

describe('parse', () => {
  it('returns parsed output or throws a ZodError', () => {
    expect(parse(z.coerce.number(), '5')).toBe(5);
    expect(() => parse(z.number(), 'x')).toThrow(z.ZodError);
  });
});
