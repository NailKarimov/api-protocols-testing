import 'dotenv/config';

/** Test environment settings. Nothing here is secret. */
export const env = {
  /** Feed seed: the same seed gives the same prices, to replay a failing run. */
  seed: Number(process.env.QUOTES_SEED ?? 7),
};
