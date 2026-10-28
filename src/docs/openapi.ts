import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import { IDEMPOTENCY_HEADER } from '../lib/idempotency';
import { type Access, type RouteDoc, routeDocs } from './routes';

type JsonSchema = Record<string, unknown>;

// Input side of each schema: what a client sends, before coercion and transforms.
const toJson = (schema: z.ZodType): JsonSchema => {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return json;
};

const ACCESS_NOTE: Record<Access, string> = {
  public: 'Public.',
  optional: 'Public; a bearer token adds personalised fields.',
  user: 'Any signed-in user.',
  prive: 'Prive membership with approved KYC.',
  full: 'Verified Prive or Institutional.',
  inst: 'Institutional membership with approved KYC.',
  staff: 'GIG staff.',
};

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

// `/companies/:id` -> `/companies/{id}`
const openApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');

function parameters(doc: RouteDoc) {
  const list: JsonSchema[] = [];
  for (const where of ['path', 'query'] as const) {
    const schema = where === 'path' ? doc.params : doc.query;
    if (!schema) continue;
    const json = toJson(schema) as { properties?: Record<string, JsonSchema>; required?: string[] };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      list.push({
        name,
        in: where,
        required: where === 'path' || (json.required ?? []).includes(name),
        schema: prop,
      });
    }
  }
  if (doc.idempotent) {
    list.push({
      name: IDEMPOTENCY_HEADER,
      in: 'header',
      required: true,
      description: 'A retry with the same key and body returns the original result.',
      schema: { type: 'string', format: 'uuid' },
    });
  }
  return list;
}

function operation(doc: RouteDoc) {
  const status = doc.status ?? 200;
  const secured = doc.access !== 'public';
  const note = [ACCESS_NOTE[doc.access], doc.permission && `Permission: \`${doc.permission}\`.`]
    .filter(Boolean)
    .join(' ');

  const responses: Record<string, unknown> = {
    [status]:
      status === 204
        ? { description: 'No content' }
        : {
            description: 'Success',
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${doc.page ? 'Page' : 'Data'}` },
              },
            },
          },
    '400': errorResponse('Validation failed'),
  };
  if (secured && doc.access !== 'optional') responses['401'] = errorResponse('Not signed in');
  if (!['public', 'optional', 'user'].includes(doc.access)) {
    responses['403'] = errorResponse('Tier, KYC or permission missing');
  }
  if (doc.params) responses['404'] = errorResponse('Not found');

  return {
    tags: [doc.tag],
    summary: doc.summary,
    description: [note, doc.description].filter(Boolean).join('\n\n'),
    operationId: `${doc.method}${doc.path.replace(/[/:-](\w)/g, (_, c: string) => c.toUpperCase())}`,
    ...(secured && {
      security: doc.access === 'optional' ? [{ bearerAuth: [] }, {}] : [{ bearerAuth: [] }],
    }),
    parameters: parameters(doc),
    ...(doc.body && {
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: toJson(doc.body),
            ...(doc.example !== undefined && { example: doc.example }),
          },
        },
      },
    }),
    responses,
  };
}

export function buildOpenApiSpec() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const doc of routeDocs) {
    (paths[openApiPath(doc.path)] ??= {})[doc.method] = operation(doc);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'GIG (Global Investorz Group) API',
      version: '1.0.0',
      description:
        'Sign in with `POST /auth/login`, then click **Authorize** and paste the `accessToken`.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [...new Set(routeDocs.map((d) => d.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Data: { type: 'object', properties: { data: {} }, required: ['data'] },
        Page: {
          type: 'object',
          properties: {
            data: { type: 'array', items: {} },
            meta: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                pageSize: { type: 'integer' },
                total: { type: 'integer' },
              },
              additionalProperties: true,
            },
          },
          required: ['data', 'meta'],
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', examples: ['VALIDATION_FAILED'] },
                message: { type: 'string' },
                fields: { type: 'object', additionalProperties: { type: 'string' } },
              },
              required: ['code', 'message'],
            },
          },
          required: ['error'],
        },
      },
    },
  };
}

/** `/api/docs` (Swagger UI) and `/api/docs/openapi.json`. */
export function docsRouter() {
  const spec = buildOpenApiSpec();
  const router = Router();
  router.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  router.use(
    '/',
    swaggerUi.serve,
    swaggerUi.setup(spec, { swaggerOptions: { persistAuthorization: true } }),
  );
  return router;
}
