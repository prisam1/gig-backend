import type { z } from 'zod';
import { validationError, type FieldErrors } from './errorHandler';

/** Parses input against a schema, or throws a VALIDATION_FAILED error keyed by field path. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fields: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_root';
    fields[key] ??= issue.message;
  }
  throw validationError(fields);
}
