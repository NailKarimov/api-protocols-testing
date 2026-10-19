// Standalone start for manual exploration (from the repository root): npm run quotes:dev
// gRPC on :50051 with reflection, so grpcurl needs no .proto file:
//   grpcurl -plaintext -H 'authorization: Bearer dev-token' -d '{"pair":"EURUSD"}' localhost:50051 quotes.v1.QuoteService/GetQuote
// WebSocket and SSE on :8080:
//   websocat -H 'Authorization: Bearer dev-token' --protocol quotes.v1 ws://localhost:8080/ws   then {"type":"subscribe","pairs":["EURUSD"]}
//   curl -N -H 'Authorization: Bearer dev-token' 'http://localhost:8080/sse?pairs=EURUSD,USDJPY'
import { QuoteFeed } from './feed.ts';
import { buildGrpcServer } from './grpc.ts';
import { buildRealtimeServer } from './realtime.ts';

const token = process.env.QUOTES_TOKEN ?? 'dev-token';
const feed = new QuoteFeed({ tickMs: 500 }).start();
const grpcServer = buildGrpcServer(feed, { token });
const port = await grpcServer.listen(Number(process.env.GRPC_PORT ?? 50051));
const realtime = buildRealtimeServer(feed, { token, heartbeatMs: 5_000 });
const httpPort = await realtime.listen(Number(process.env.HTTP_PORT ?? 8080));
console.log(`gRPC quotes.v1.QuoteService on 127.0.0.1:${port}`);
console.log(`WebSocket ws://127.0.0.1:${httpPort}/ws · SSE http://127.0.0.1:${httpPort}/sse?pairs=EURUSD`);
console.log(`token: ${process.env.QUOTES_TOKEN ? 'from QUOTES_TOKEN' : 'dev-token'}`);
