import { z } from 'zod';
import { PAIRS, SPREAD } from '../../services/quotes/src/feed.ts';

/**
 * The contract of a quote beyond its types: the same rules for every protocol (gRPC, WebSocket, SSE).
 * Prices have the pair's number of decimals (5, or 3 for JPY), bid < ask, the spread is 1–3 pips.
 */
export function quoteProblems(q: { pair: string; bid: string; ask: string; seq: number }): string[] {
  const p = PAIRS[q.pair];
  if (!p) return [`unknown pair ${q.pair}`];
  const price = new RegExp(`^\\d+\\.\\d{${p.digits}}$`);
  const out: string[] = [];
  if (!price.test(q.bid)) out.push(`bid ${q.bid} must have ${p.digits} decimals`);
  if (!price.test(q.ask)) out.push(`ask ${q.ask} must have ${p.digits} decimals`);
  const units = (s: string) => Math.round(Number(s) * 10 ** p.digits);
  const spread = units(q.ask) - units(q.bid);
  if (spread < SPREAD.min || spread > SPREAD.max)
    out.push(`spread ${spread} outside ${SPREAD.min}–${SPREAD.max}`);
  if (!(Number.isInteger(q.seq) && q.seq > 0)) out.push(`seq ${q.seq} must be a positive integer`);
  return out;
}

export const timestamp = z.object({
  seconds: z.number().int().positive(),
  nanos: z.number().int().min(0).max(999_999_999),
});

/** Per pair, seq must go up by exactly one: no lost and no repeated updates. Returns the gaps found. */
export function seqGaps(quotes: { pair: string; seq: number }[]): string[] {
  const last = new Map<string, number>();
  const gaps: string[] = [];
  for (const q of quotes) {
    const prev = last.get(q.pair);
    if (prev !== undefined && q.seq !== prev + 1) gaps.push(`${q.pair}: ${prev} → ${q.seq}`);
    last.set(q.pair, q.seq);
  }
  return gaps;
}

export const order = (id: string, over: Partial<{ pair: string; side: string; amount: string }> = {}) => ({
  client_order_id: id,
  pair: 'EURUSD',
  side: 'SIDE_BUY',
  amount: '1000.00',
  ...over,
});
