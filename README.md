# api-protocols-testing

[![Tests](https://github.com/NailKarimov/api-protocols-testing/actions/workflows/tests.yml/badge.svg)](https://github.com/NailKarimov/api-protocols-testing/actions/workflows/tests.yml)
[![Allure report](https://img.shields.io/badge/report-Allure-orange)](https://nailkarimov.github.io/api-protocols-testing/)

Testing APIs beyond REST. One FX quotes service of our own (EUR/USD, USD/JPY…) serves the same live feed over
**gRPC**, **WebSocket** and **Server-Sent Events**, so the tests compare the protocols on the same data.

- **System under test:** `services/quotes`: a seeded random-walk quote feed (same seed, same prices) and a gRPC
  server for `proto/quotes/v1/quotes.proto`: unary, server streaming, client streaming and bidirectional streaming,
  plus the standard health and reflection services; and an HTTP server with WebSocket `/ws` and SSE `/sse`.
- **In-process per worker:** every Playwright worker starts its own feed and server on a free port; no Docker needed.
- **The .proto is the contract:** `buf lint` and `buf breaking` against an approved snapshot, in CI and on every PR.

## gRPC (47 tests)

| Spec                      | What it proves                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grpc/unary`              | quote contract (5 decimals, 3 for JPY; bid < ask; 1–3 pip spread; fresh time); status codes INVALID_ARGUMENT, NOT_FOUND, UNAUTHENTICATED, RESOURCE_EXHAUSTED (64 KiB), UNIMPLEMENTED; deadlines, and the server stops the abandoned work; request id in headers and trailers                                                            |
| `grpc/streaming`          | server stream: snapshot first, then updates **without seq gaps**, OK at `max_updates`; cancel frees the server's listener; deadline on an endless stream. Client stream: counts, exact decimal sum, named rejections, 1 000 / 1 001 orders. Bidi: fills in order, buy at the ask and sell at the bid of the quote it was priced against |
| `grpc/health-reflection`  | `grpc.health.v1` SERVING / NOT_SERVING / NOT_FOUND, public without a token; reflection lists every service and describes the API without the `.proto`                                                                                                                                                                                   |
| `contract/proto-breaking` | the `.proto` matches the approved snapshot; 8 typical edits are caught (type change, removed field or RPC, renamed field, unary → streaming, removed enum value, renamed package), adding a field passes                                                                                                                                |

**Do the tests catch bugs?** 12 bugs were planted by hand (no token check, work going on after the deadline, a
leaked stream listener, no snapshot, every 10th update dropped, the buyer paying the bid, duplicate orders allowed,
an off-by-one order limit, NOT_FOUND reported as INVALID_ARGUMENT, request id missing from trailers, JPY priced
with 5 decimals, no request size limit): all 12 caught. `buf lint` itself found a design issue on day one: several
RPCs shared request and response messages, so none of them could evolve alone. Details: [`docs/grpc.md`](docs/grpc.md) ·
visual guide: [`docs/grpc.html`](https://nailkarimov.github.io/api-protocols-testing/grpc.html).

## WebSocket and SSE (32 tests)

| Spec                      | What it proves                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realtime/websocket`      | handshake: 401 before the upgrade, subprotocol `quotes.v1` (none → 1002); ack, snapshot, no seq gaps; 6 bad messages answered while the socket stays, the 5th → 1008; 5 KiB frame → 1009; unsubscribe; **drop and resume with `since`: nothing missed, nothing twice**; stale `since` → reset; a client that never pongs is dropped; shutdown → 1001; 20 clients see identical prices; closed clients free their listeners |
| `realtime/sse`            | SSE headers, `retry`, an id that is a cursor of all pairs; **resume with `Last-Event-ID`**; stale cursor → reset; heartbeat comments; 401 / 406 / 400 / 404 as JSON; closed tabs free their listeners; shutdown ends the stream                                                                                                                                                                                            |
| `realtime/cross-protocol` | gRPC, WebSocket and SSE report the same bid/ask for every common seq                                                                                                                                                                                                                                                                                                                                                       |

14 bugs planted in the WebSocket and SSE server (resume ignored, a cursor naming one pair, silent clients never
dropped, leaked listeners, no 1001 on shutdown, …): all 14 caught. Details: [`docs/realtime.md`](docs/realtime.md) ·
visual guide with a connection you cut and resume:
[`docs/realtime.html`](https://nailkarimov.github.io/api-protocols-testing/realtime.html).

## Running it

```bash
npm ci
npm test                 # everything
npm run test:grpc        # gRPC only
npm run test:realtime   # WebSocket and SSE
npm run test:contract    # buf breaking against contracts/quotes.v1.binpb
npm run proto:lint       # buf lint + format check
npm run quotes:dev       # by hand: gRPC on :50051, WebSocket and SSE on :8080, then for example:
grpcurl -plaintext -H 'authorization: Bearer dev-token' -d '{"pair":"EURUSD"}' localhost:50051 quotes.v1.QuoteService/GetQuote
curl -N -H 'Authorization: Bearer dev-token' 'http://localhost:8080/sse?pairs=EURUSD,USDJPY'
```

A deliberate contract change: edit the `.proto`, run `npm run proto:approve`, commit both files.

## Part of a portfolio

REST and GraphQL tests of public APIs: [api-test-automation](https://github.com/NailKarimov/api-test-automation) ·
contract testing: [contract-testing-lab](https://github.com/NailKarimov/contract-testing-lab) ·
microservices: [microservices-testing](https://github.com/NailKarimov/microservices-testing) ·
database and OAuth 2.0: [ledger-api-testing](https://github.com/NailKarimov/ledger-api-testing) ·
overview: [github.com/NailKarimov](https://github.com/NailKarimov).

**Stack:** TypeScript · gRPC (`@grpc/grpc-js`, proto-loader, health, reflection) · Protocol Buffers · buf · WebSocket
(`ws`) · Server-Sent Events · Playwright
Test · zod · Allure · GitHub Actions.
