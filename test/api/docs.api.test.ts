import type { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { buildOpenApiSpec } from '../../src/docs/openapi';
import { routeDocs } from '../../src/docs/routes';
import { adminRouter } from '../../src/modules/admin/admin.routes';
import { authRouter } from '../../src/modules/auth/auth.routes';
import { companiesRouter } from '../../src/modules/catalog/catalog.routes';
import { creditsRouter } from '../../src/modules/credits/credits.routes';
import { filesRouter } from '../../src/modules/files/files.routes';
import { kycRouter } from '../../src/modules/kyc/kyc.routes';
import { learnRouter } from '../../src/modules/learn/learn.routes';
import { issuersRouter } from '../../src/modules/ratings/ratings.routes';
import { representationsRouter } from '../../src/modules/representations/representations.routes';
import { reviewsRouter } from '../../src/modules/reviews/reviews.routes';
import { roadshowsRouter } from '../../src/modules/roadshows/roadshows.routes';
import { savedRouter } from '../../src/modules/saved/saved.routes';
import { topRatedRouter } from '../../src/modules/topRated/topRated.routes';
import { lookupsRouter } from '../../src/modules/users/lookups.routes';
import { meRouter } from '../../src/modules/users/users.routes';
import { webinarsRouter } from '../../src/modules/webinars/webinars.routes';
import { router } from '../../src/routes';
import { fake } from '../helpers/fakeSupabase';

vi.mock('../../src/lib/supabase', async () => {
  const { fake } = await import('../helpers/fakeSupabase');
  return { supabaseAdmin: fake.client };
});
vi.mock('../../src/lib/auth', async () => {
  const { fakeLoadMember } = await import('../helpers/fakeSupabase');
  return { authProvider: { loadMember: fakeLoadMember } };
});

const app = createApp();

beforeEach(() => {
  fake.reset();
});

// Mirrors src/routes/index.ts. A router mounted there but missing here fails the first test.
const MOUNTS = new Map<Router, string>([
  [authRouter, '/auth'],
  [savedRouter, '/me/saved'],
  [creditsRouter, '/me/credits'],
  [meRouter, '/me'],
  [filesRouter, '/files'],
  [kycRouter, '/kyc'],
  [lookupsRouter, '/lookups'],
  [companiesRouter, '/companies'],
  [reviewsRouter, '/reviews'],
  [issuersRouter, '/issuers'],
  [representationsRouter, '/representations'],
  [learnRouter, '/learn'],
  [webinarsRouter, '/webinars'],
  [topRatedRouter, '/top-rated'],
  [roadshowsRouter, '/roadshows'],
  [adminRouter, '/admin'],
]);

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
}

function servedRoutes(): string[] {
  const routes: string[] = [];
  const add = (prefix: string, layer: Layer) => {
    for (const method of Object.keys(layer.route!.methods)) {
      const path = prefix + (layer.route!.path === '/' && prefix ? '' : layer.route!.path);
      routes.push(`${method.toUpperCase()} ${path}`);
    }
  };
  for (const layer of router.stack as unknown as Layer[]) {
    if (layer.route) add('', layer);
    else if (layer.handle.stack) {
      const prefix = MOUNTS.get(layer.handle as unknown as Router);
      expect(prefix, 'a router mounted in src/routes is missing from MOUNTS').toBeDefined();
      for (const sub of layer.handle.stack) if (sub.route) add(prefix!, sub);
    }
  }
  return routes.sort();
}

describe('API docs', () => {
  it('documents every route the API serves, and nothing else', () => {
    const documented = routeDocs.map((d) => `${d.method.toUpperCase()} ${d.path}`).sort();
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented).toEqual(servedRoutes());
  });

  it('builds a valid OpenAPI document', () => {
    const spec = buildOpenApiSpec();
    expect(spec.openapi).toBe('3.1.0');
    const operations = Object.values(spec.paths).flatMap((p) => Object.values(p));
    expect(operations).toHaveLength(routeDocs.length);
    const ids = operations.map((op) => (op as { operationId: string }).operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('describes request bodies and path parameters from the zod schemas', () => {
    const spec = buildOpenApiSpec();
    const login = spec.paths['/auth/login']?.['post'] as {
      requestBody: { content: { 'application/json': { schema: { properties: object } } } };
    };
    expect(Object.keys(login.requestBody.content['application/json'].schema.properties)).toContain(
      'password',
    );
    const company = spec.paths['/companies/{id}']?.['get'] as {
      parameters: { name: string; in: string }[];
    };
    expect(company.parameters).toContainEqual(expect.objectContaining({ name: 'id', in: 'path' }));
  });

  it('prefills only request bodies that pass validation', () => {
    const withExamples = routeDocs.filter((d) => d.example !== undefined);
    expect(withExamples.length).toBeGreaterThan(0);
    for (const doc of withExamples) {
      const result = doc.body!.safeParse(doc.example);
      expect(result.error?.issues, `${doc.method} ${doc.path}`).toBeUndefined();
    }
  });

  it('serves the spec as JSON and the Swagger UI page', async () => {
    const json = await request(app).get('/api/docs/openapi.json').expect(200);
    expect(json.body.info.title).toMatch(/GIG/);
    const ui = await request(app).get('/api/docs/').expect(200);
    expect(ui.text).toContain('swagger-ui');
  });

  it('lets "Try it out" call the API over plain http (local development)', async () => {
    const ui = await request(app).get('/api/docs/').expect(200);
    const csp = String(ui.headers['content-security-policy']);
    // upgrade-insecure-requests would turn every call into https://localhost and fail silently.
    expect(csp).not.toContain('upgrade-insecure-requests');
    // The rest of the policy still applies to the docs page.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
  });
});
