import { EventEmitter } from 'node:events';

/**
 * The FX quote feed behind every protocol (gRPC, WebSocket, SSE): a seeded random walk of bid/ask prices.
 * Same seed → same prices, so a failing test can be replayed. Prices are integers in the pair's smallest unit
 * (1e-5, or 1e-3 for JPY pairs) and leave the feed as decimal strings.
 */
export type Quote = { pair: string; bid: string; ask: string; seq: number; time: Date };

export const PAIRS: Record<string, { start: number; digits: number }> = {
  EURUSD: { start: 1.085, digits: 5 },
  GBPUSD: { start: 1.27, digits: 5 },
  EURGBP: { start: 0.854, digits: 5 },
  USDCHF: { start: 0.881, digits: 5 },
  USDJPY: { start: 151.2, digits: 3 },
};

/** Spread limits in the pair's smallest unit: 10–30 points, i.e. 1–3 pips. */
export const SPREAD = { min: 10, max: 30 };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const format = (units: number, digits: number) => (units / 10 ** digits).toFixed(digits);

export type FeedOptions = { seed?: number; tickMs?: number; historySize?: number };

export class QuoteFeed {
  private readonly events = new EventEmitter();
  private readonly rnd: () => number;
  private readonly mid = new Map<string, number>();
  private readonly seq = new Map<string, number>();
  private readonly history = new Map<string, Quote[]>();
  private readonly latest = new Map<string, Quote>();
  private timer?: NodeJS.Timeout;
  readonly tickMs: number;
  private readonly historySize: number;

  constructor(opts: FeedOptions = {}) {
    this.rnd = mulberry32(opts.seed ?? 42);
    this.tickMs = opts.tickMs ?? 250;
    this.historySize = opts.historySize ?? 1_000;
    this.events.setMaxListeners(0);
    for (const [pair, p] of Object.entries(PAIRS)) {
      this.mid.set(pair, Math.round(p.start * 10 ** p.digits));
      this.seq.set(pair, 0);
      this.history.set(pair, []);
      this.next(pair);
    }
  }

  static isKnown(pair: string) {
    return Object.hasOwn(PAIRS, pair);
  }

  start() {
    this.timer ??= setInterval(() => {
      for (const pair of Object.keys(PAIRS)) this.next(pair);
    }, this.tickMs);
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One new quote for a pair: the mid moves by up to ±5 points, the spread stays within SPREAD. */
  next(pair: string): Quote {
    const { digits } = PAIRS[pair]!;
    const mid = this.mid.get(pair)! + Math.round((this.rnd() - 0.5) * 10);
    this.mid.set(pair, mid);
    const spread = SPREAD.min + Math.floor(this.rnd() * (SPREAD.max - SPREAD.min + 1));
    const bid = mid - Math.floor(spread / 2);
    const seq = this.seq.get(pair)! + 1;
    this.seq.set(pair, seq);
    const q: Quote = {
      pair,
      bid: format(bid, digits),
      ask: format(bid + spread, digits),
      seq,
      time: new Date(),
    };
    const h = this.history.get(pair)!;
    h.push(q);
    if (h.length > this.historySize) h.shift();
    this.latest.set(pair, q);
    this.events.emit('quote', q);
    return q;
  }

  current(pair: string): Quote {
    return this.latest.get(pair)!;
  }

  /** Quotes after `seq` that are still in the history (for resuming a WebSocket or SSE stream). */
  since(pair: string, seq: number): Quote[] {
    return this.history.get(pair)!.filter((q) => q.seq > seq);
  }

  /** The quote with exactly this seq, if still in the history: the test oracle for fills. */
  at(pair: string, seq: number): Quote | undefined {
    return this.history.get(pair)!.find((q) => q.seq === seq);
  }

  oldestSeq(pair: string): number {
    return this.history.get(pair)![0]?.seq ?? 0;
  }

  subscribe(fn: (q: Quote) => void): () => void {
    this.events.on('quote', fn);
    return () => this.events.off('quote', fn);
  }

  /** Live subscriptions: must return to its old value when clients go away (no leaked listeners). */
  get subscribers(): number {
    return this.events.listenerCount('quote');
  }
}
