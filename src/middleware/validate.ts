import type { z } from 'zod';
import { AppError } from './errorHandler';

// Parses untrusted input. On failure, returns 400 with one message per field, e.g.
// { fields: { email: "Email must contain @", "device.platform": "..." } }.
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  throw new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', fields);
}
