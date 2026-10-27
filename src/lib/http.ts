import type { Response } from 'express';
import { z } from 'zod';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

/** Parses untrusted input; a ZodError becomes a 400 VALIDATION_FAILED in the error handler. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  return schema.parse(input);
}

export function sendData<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ data });
}

export function sendPage<T>(res: Response, data: T[], meta: PageMeta): void {
  res.status(200).json({ data, meta });
}

/** `?page=1&pageSize=20`, shared by every list endpoint. */
export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

/** Comma-separated query value (`a,b,c`) or repeated keys, parsed into a de-duplicated list. */
export function csv<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      (Array.isArray(v) ? v : [v])
        .flatMap((s) => s.split(','))
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item))
    .transform((list) => [...new Set(list)]);
}

export function pageRange({ page, pageSize }: { page: number; pageSize: number }) {
  const from = (page - 1) * pageSize;
  return { from, to: from + pageSize - 1 };
}

/** Escapes LIKE wildcards so user input matches literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `%term%` for a case-insensitive "contains" search on a lower-cased column. */
export function containsPattern(term: string): string {
  return `%${escapeLike(term.toLowerCase())}%`;
}
