import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * The .proto file is the contract. `buf breaking` compares it with the approved snapshot
 * (contracts/quotes.v1.binpb, rebuilt with `npm run proto:approve` when a change is accepted). The self-test feeds
 * it typical edits: the breaking ones must be caught, the safe one must pass.
 */
const AGAINST = 'contracts/quotes.v1.binpb';

function breaking(dir: string): { ok: boolean; rules: string[] } {
  try {
    execFileSync('npx', ['buf', 'breaking', dir, '--against', AGAINST, '--error-format=json'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, rules: [] };
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '');
    const rules = out
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { type: string }).type);
    return { ok: false, rules: [...new Set(rules)] };
  }
}

function variant(edit: (s: string) => string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'proto-'));
  cpSync('proto', dir, { recursive: true });
  const file = path.join(dir, 'quotes/v1/quotes.proto');
  const before = readFileSync(file, 'utf8');
  const after = edit(before);
  if (after === before) throw new Error('the edit changed nothing');
  writeFileSync(file, after);
  return dir;
}

test.describe('Proto contract: buf breaking', () => {
  test('the current .proto has no breaking change against the approved snapshot', { tag: '@smoke' }, () => {
    expect(breaking('proto')).toEqual({ ok: true, rules: [] });
  });

  const cases: [string, (s: string) => string, string][] = [
    [
      'a field changes type (string bid → double)',
      (s) => s.replace('string bid = 2;', 'double bid = 2;'),
      'FIELD_SAME_TYPE',
    ],
    ['a field is removed', (s) => s.replace(/\s*uint64 seq = 4;[^\n]*/, ''), 'FIELD_NO_DELETE'],
    [
      'a field number changes (ask 3 → 6)',
      (s) => s.replace('string ask = 3;', 'string ask = 6;'),
      'FIELD_NO_DELETE',
    ],
    [
      'a field is renamed (breaks JSON clients)',
      (s) => s.replace('string bid = 2;', 'string bid_price = 2;'),
      'FIELD_SAME_JSON_NAME',
    ],
    [
      'an RPC is removed',
      (s) => s.replace(/\s*\/\/ Bidirectional[^\n]*\n\s*rpc Trade[^\n]*/, ''),
      'RPC_NO_DELETE',
    ],
    [
      'a unary RPC becomes streaming',
      (s) => s.replace('returns (GetQuoteResponse)', 'returns (stream GetQuoteResponse)'),
      'RPC_SAME_SERVER_STREAMING',
    ],
    ['an enum value is removed', (s) => s.replace(/\s*SIDE_SELL = 2;/, ''), 'ENUM_VALUE_NO_DELETE'],
    [
      'the package is renamed',
      (s) => s.replace('package quotes.v1;', 'package quotes.v2;'),
      'FILE_SAME_PACKAGE',
    ],
  ];
  for (const [name, edit, rule] of cases) {
    test(`caught: ${name} → ${rule}`, () => {
      const res = breaking(variant(edit));
      expect(res.ok).toBe(false);
      expect(res.rules).toContain(rule);
    });
  }

  test('adding a new optional field is safe', () => {
    const res = breaking(
      variant((s) =>
        s.replace(
          'google.protobuf.Timestamp time = 5;',
          'google.protobuf.Timestamp time = 5;\n  string venue = 6;',
        ),
      ),
    );
    expect(res).toEqual({ ok: true, rules: [] });
  });
});
