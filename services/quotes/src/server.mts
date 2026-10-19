// Standalone start for manual exploration (from the repository root): npm run quotes:dev
// gRPC on :50051 with reflection, so grpcurl needs no .proto file:
//   grpcurl -plaintext -H 'authorization: Bearer dev-token' -d '{"pair":"EURUSD"}' localhost:50051 quotes.v1.QuoteService/GetQuote
import { QuoteFeed } from './feed.ts';
import { buildGrpcServer } from './grpc.ts';

const feed = new QuoteFeed({ tickMs: 500 }).start();
const grpcServer = buildGrpcServer(feed, { token: process.env.QUOTES_TOKEN ?? 'dev-token' });
const port = await grpcServer.listen(Number(process.env.GRPC_PORT ?? 50051));
console.log(
  `gRPC quotes.v1.QuoteService on 127.0.0.1:${port} (token: ${process.env.QUOTES_TOKEN ? 'from QUOTES_TOKEN' : 'dev-token'})`,
);
