import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { test, expect } from '../../src/quotes/fixtures';

/**
 * Two standard services every production gRPC server should offer: health checking (what Kubernetes and load
 * balancers call) and server reflection (what grpcurl and Postman use to discover the API without the .proto).
 */
function client(name: 'health' | 'reflection', address: string) {
  const file =
    name === 'health'
      ? path.resolve('node_modules/grpc-health-check/proto/health/v1/health.proto')
      : path.join(
          path.dirname(require.resolve('@grpc/reflection/package.json')),
          'build/proto/grpc/reflection/v1/reflection.proto',
        );
  const pkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(file, { keepCase: true, enums: String }),
  ) as never as {
    grpc: {
      health: { v1: { Health: grpc.ServiceClientConstructor } };
      reflection: { v1: { ServerReflection: grpc.ServiceClientConstructor } };
    };
  };
  const ctor = name === 'health' ? pkg.grpc.health.v1.Health : pkg.grpc.reflection.v1.ServerReflection;
  return new ctor(address, grpc.credentials.createInsecure()) as grpc.Client &
    Record<string, (...a: unknown[]) => unknown>;
}

const check = (c: ReturnType<typeof client>, service: string) =>
  new Promise<{ code: number; status?: string }>((resolve) =>
    (c.Check as (...a: unknown[]) => void)(
      { service },
      (err: grpc.ServiceError | null, res?: { status: string }) =>
        resolve({ code: err?.code ?? 0, status: res?.status }),
    ),
  );

test.describe('gRPC health and reflection', () => {
  test(
    'health: the server and the quote service are SERVING; an unknown service is NOT_FOUND',
    { tag: '@smoke' },
    async ({ quotesEnv }) => {
      const c = client('health', quotesEnv.grpcAddress);
      try {
        expect(await check(c, '')).toEqual({ code: 0, status: 'SERVING' });
        expect(await check(c, 'quotes.v1.QuoteService')).toEqual({ code: 0, status: 'SERVING' });
        expect((await check(c, 'quotes.v1.Nope')).code).toBe(grpc.status.NOT_FOUND);
      } finally {
        c.close();
      }
    },
  );

  test('health follows the service: NOT_SERVING while it is drained', async ({ quotesEnv }) => {
    const c = client('health', quotesEnv.grpcAddress);
    try {
      quotesEnv.health.setStatus('quotes.v1.QuoteService', 'NOT_SERVING');
      expect((await check(c, 'quotes.v1.QuoteService')).status).toBe('NOT_SERVING');
    } finally {
      quotesEnv.health.setStatus('quotes.v1.QuoteService', 'SERVING');
      c.close();
    }
  });

  test('health is public: it answers without a token', async ({ quotesEnv }) => {
    const c = client('health', quotesEnv.grpcAddress);
    try {
      expect((await check(c, '')).code).toBe(0);
    } finally {
      c.close();
    }
  });

  test('reflection lists the services and describes the API without the .proto file', async ({
    quotesEnv,
  }) => {
    const c = client('reflection', quotesEnv.grpcAddress);
    try {
      const ask = (req: Record<string, string>) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const call = (
            c.ServerReflectionInfo as () => grpc.ClientDuplexStream<unknown, Record<string, unknown>>
          )();
          call.on('data', (r) => {
            resolve(r);
            call.end();
          });
          call.on('error', reject);
          call.write(req);
        });

      const list = (await ask({ list_services: '' })) as {
        list_services_response: { service: { name: string }[] };
      };
      const names = list.list_services_response.service.map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(['quotes.v1.QuoteService', 'grpc.health.v1.Health']));

      const file = (await ask({ file_containing_symbol: 'quotes.v1.QuoteService' })) as {
        file_descriptor_response: { file_descriptor_proto: Buffer[] };
      };
      const descriptor = Buffer.concat(file.file_descriptor_response.file_descriptor_proto).toString(
        'latin1',
      );
      for (const rpc of ['GetQuote', 'Subscribe', 'SubmitOrders', 'Trade']) expect(descriptor).toContain(rpc);
    } finally {
      c.close();
    }
  });
});
