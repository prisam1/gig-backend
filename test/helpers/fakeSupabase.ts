// In-memory stand-in for the Supabase client, used by the HTTP tests.
// Every query builder chain (from().select().eq()...) is recorded, and the awaited result comes
// from a handler registered per table / RPC, so tests control exactly what the database "returns".

export interface FakeResult {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
}

export interface FakeCall {
  kind: 'from' | 'rpc' | 'exists';
  name: string;
  /** rpc: [args, options]; exists: [path] */
  args: unknown[];
  chain: { method: string; args: unknown[] }[];
}

type Handler = (call: FakeCall) => FakeResult | Promise<FakeResult>;

export const TEST_USERS = {
  observer: { id: '11111111-1111-4111-8111-111111111111', tier: 'OBSERVER', kyc: 'NOT_STARTED' },
  prive: { id: '22222222-2222-4222-8222-222222222222', tier: 'PRIVE', kyc: 'APPROVED' },
  privePending: { id: '33333333-3333-4333-8333-333333333333', tier: 'PRIVE', kyc: 'PENDING' },
  institutional: {
    id: '44444444-4444-4444-8444-444444444444',
    tier: 'INSTITUTIONAL',
    kyc: 'APPROVED',
  },
} as const;

export type TestUser = keyof typeof TEST_USERS;

/** Bearer token for a test user; the fake auth accepts exactly these. */
export const tokenFor = (user: TestUser) => `test-token-${user}`;

function createFakeSupabase() {
  const handlers = new Map<string, Handler>();
  const calls: FakeCall[] = [];

  function record(kind: FakeCall['kind'], name: string, args: unknown[]): FakeCall {
    const call: FakeCall = { kind, name, args, chain: [] };
    calls.push(call);
    return call;
  }

  async function run(call: FakeCall) {
    const handler = handlers.get(`${call.kind}:${call.name}`);
    if (!handler) throw new Error(`No fake handler for ${call.kind}:${call.name}`);
    const result = await handler(call);
    return { data: result.data ?? null, error: result.error ?? null, count: result.count ?? null };
  }

  /** A thenable proxy: any method call is recorded and returns the same builder. */
  function builder(call: FakeCall): unknown {
    const proxy: unknown = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          return (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
            run(call).then(onFulfilled, onRejected);
        }
        return (...args: unknown[]) => {
          call.chain.push({ method: String(prop), args });
          return proxy;
        };
      },
    });
    return proxy;
  }

  const client = {
    from: (table: string) => builder(record('from', table, [])),
    rpc: (name: string, args?: unknown, options?: unknown) =>
      builder(record('rpc', name, [args, options])),
    storage: {
      from: (bucket: string) => ({
        exists: (path: string) => run(record('exists', bucket, [path])),
      }),
    },
    auth: {
      getClaims: async (token: string) => {
        const entry = Object.entries(TEST_USERS).find(
          ([key]) => tokenFor(key as TestUser) === token,
        );
        if (!entry) return { data: null, error: { message: 'invalid JWT' } };
        const [key, user] = entry;
        return {
          data: {
            claims: {
              sub: user.id,
              app_metadata: { tier: user.tier, kyc_status: user.kyc },
              user_metadata: { full_name: key === 'prive' ? 'Shreya Mehta' : 'Test User' },
            },
          },
          error: null,
        };
      },
    },
  };

  return {
    client,
    calls,
    /** Register the result for `from:<table>`, `rpc:<name>` or `exists:<bucket>`. */
    on(key: string, handler: Handler | FakeResult) {
      handlers.set(key, typeof handler === 'function' ? handler : () => handler);
    },
    reset() {
      handlers.clear();
      calls.length = 0;
    },
    /** Calls recorded for one table / RPC. */
    callsTo(key: string) {
      return calls.filter((c) => `${c.kind}:${c.name}` === key);
    },
  };
}

export const fake = createFakeSupabase();

/** First argument list passed to `method` in a recorded chain. */
export function chainArgs(call: FakeCall | undefined, method: string): unknown[] | undefined {
  return call?.chain.find((c) => c.method === method)?.args;
}

/** All argument lists passed to `method` in a recorded chain. */
export function allChainArgs(call: FakeCall | undefined, method: string): unknown[][] {
  return call?.chain.filter((c) => c.method === method).map((c) => c.args) ?? [];
}
