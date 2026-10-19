# gRPC: testing a service by its .proto contract

Visual version (the four kinds of call animated, gRPC vs HTTP status codes, a deadline you can drag, a stream
that loses an update, breaking `.proto` edits, RU/EN):
[`docs/grpc.html`](https://nailkarimov.github.io/api-protocols-testing/grpc.html).

## What gRPC is, in one paragraph

gRPC is a way for services to call each other's functions over HTTP/2. The API is described in a `.proto` file
(Protocol Buffers): services, methods and typed messages. Code for clients and servers is generated from it,
messages travel as compact binary, and a call can be one request and one response or a **stream** in either or
both directions. It is common between microservices, in fintech and in mobile back ends; on the outside it
replaces REST, inside it replaces JSON over HTTP.

What changes for a tester compared with REST:

| REST                              | gRPC                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| OpenAPI document, often optional  | the `.proto` file is mandatory, and the clients are generated from it                                 |
| HTTP status code                  | one of 17 gRPC status codes (`OK`, `INVALID_ARGUMENT`, `NOT_FOUND`, `DEADLINE_EXCEEDED`…) + `details` |
| headers                           | **metadata**: headers before the response, **trailers** after it                                      |
| timeout set by the client library | **deadline** travels with the call; the server sees it and should stop working when it passes         |
| curl, Postman                     | grpcurl, Postman, or code; **reflection** lets tools discover the API without the `.proto`            |
| request → response                | unary, server streaming, client streaming, bidirectional streaming                                    |
| breaking change: hard to notice   | `buf breaking` compares two `.proto` versions by rules                                                |

## The system under test

`services/quotes` is an FX quote service written for this repository: a seeded random walk of bid/ask prices
for EURUSD, GBPUSD, EURGBP, USDCHF and USDJPY. The same seed gives the same prices, so a failure can be replayed
(`QUOTES_SEED`). Prices are decimal strings (5 places, 3 for JPY pairs), never binary floats; every quote has a
`seq` that grows by exactly one per pair, so a client can tell when an update was lost.

The contract, [`proto/quotes/v1/quotes.proto`](../proto/quotes/v1/quotes.proto):

| RPC            | Kind                    | What it does                                                                      |
| -------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `GetQuote`     | unary                   | the latest quote of one pair; `delay_ms` makes the server slow, to test deadlines |
| `Subscribe`    | server streaming        | a snapshot of every requested pair, then live updates; ends at `max_updates`      |
| `SubmitOrders` | client streaming        | the client uploads a batch of orders as a stream; one summary at the end          |
| `Trade`        | bidirectional streaming | every order gets a fill (or a rejection) as soon as it arrives                    |

Every call needs `authorization: Bearer <token>` metadata; `x-request-id` comes back in headers and trailers;
requests over 64 KiB are refused by the transport. The server also runs the standard `grpc.health.v1.Health`
service (what Kubernetes and load balancers call) and server reflection (what grpcurl uses).

Tests start the feed (a tick every 20 ms) and the server in the test process, one per Playwright worker, on a free
port. `src/grpc/QuotesClient.ts` turns every call into an `Outcome`: status name, details, messages, headers,
trailers and duration. Tests assert on the status like on an HTTP status, and every call is attached to the Allure
report with the token masked.

## What the tests check (47)

| Spec                      | Technique                            | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unary.spec`              | Contract testing, negative, boundary | quote invariants; 6 malformed pairs → `INVALID_ARGUMENT`; unlisted pair → `NOT_FOUND`; no or wrong token → `UNAUTHENTICATED`; request id echoed; deadline 200 ms vs 2 s of work → `DEADLINE_EXCEEDED` in under 1 s **and the server's abandoned-work counter grows**; 100 ms of work in a 1 s deadline → `OK`; `delay_ms` 10 001 → `INVALID_ARGUMENT`; 70 KiB request → `RESOURCE_EXHAUSTED`; unknown method → `UNIMPLEMENTED`; the token never reaches the report                                                                                                                                                                                                                               |
| `streaming.spec`          | State, ordering, resource cleanup    | server stream: snapshot first, then updates with **no seq gaps**, `OK` after exactly `max_updates`; a quiet market still gets the snapshot; only requested pairs; client cancel → `CANCELLED` and the server's listener is gone; deadline on an endless stream; 4 invalid subscriptions fail before any message. Client stream: 3 valid of 7, exact decimal total `1000300.50`, each rejection named; empty stream; 1 000 orders pass, 1 001 → `RESOURCE_EXHAUSTED`. Bidi: fills in order, buy at the ask and sell at the bid **of the quote with the `quote_seq` the server reported** (the feed is the oracle); a bad order is rejected and the stream goes on; 200 orders in one conversation |
| `health-reflection.spec`  | Operability                          | health `SERVING`; `NOT_SERVING` while drained; unknown service → `NOT_FOUND`; health is public; reflection lists our service and the health service and returns the descriptor with all four RPCs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `contract/proto-breaking` | Contract testing (schema evolution)  | the current `.proto` vs the approved snapshot `contracts/quotes.v1.binpb`; 8 breaking edits caught with their buf rule; adding a field passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## The .proto as a contract: buf

[buf](https://buf.build) is the standard tool for Protocol Buffers:

- `npm run proto:lint`: `buf lint` (STANDARD rules) and `buf format`. In CI on every push.
- `buf breaking` on every pull request, against `main`, and in the test suite against the approved snapshot.
- `npm run proto:approve` rebuilds the snapshot when a change is deliberate; it is committed with the `.proto`.

The self-test proves the guard works. Each edit below is applied to a copy of the `.proto`:

| Edit                              | buf rule                    | Why it breaks clients                                               |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `string bid` → `double bid`       | `FIELD_SAME_TYPE`           | old clients read the bytes as the wrong type                        |
| field `seq` removed               | `FIELD_NO_DELETE`           | clients relying on it get the default 0                             |
| `ask = 3` → `ask = 6`             | `FIELD_NO_DELETE`           | the wire identifies fields by number, not by name                   |
| `bid` → `bid_price`               | `FIELD_SAME_JSON_NAME`      | binary clients survive, JSON clients (gRPC-Gateway, grpcurl) do not |
| RPC `Trade` removed               | `RPC_NO_DELETE`             | existing clients get `UNIMPLEMENTED`                                |
| `GetQuote` becomes streaming      | `RPC_SAME_SERVER_STREAMING` | generated client code changes shape                                 |
| enum value `SIDE_SELL` removed    | `ENUM_VALUE_NO_DELETE`      | old clients still send 2                                            |
| `package quotes.v1` → `quotes.v2` | `FILE_SAME_PACKAGE`         | the full method name changes: every call is `UNIMPLEMENTED`         |
| new field `venue = 6`             | none                        | **safe**: old clients ignore unknown fields                         |

**A finding on day one.** The first version of the `.proto` reused `Quote` as the response of two RPCs and
`Order` as the request of two. `buf lint` refused it (`RPC_REQUEST_RESPONSE_UNIQUE`,
`RPC_RESPONSE_STANDARD_NAME`): with shared messages one RPC cannot gain a field without changing the other. The
contract now has `GetQuoteResponse`, `SubscribeResponse`, `SubmitOrdersRequest`, `SubmitOrdersResponse`,
`TradeRequest` and `TradeResponse`, wrapping the shared `Quote` and `Order`.

## Do the tests catch real bugs?

Each bug was planted in the code, the gRPC suite run, the change reverted:

| Planted bug                                         | Caught by                                                     |
| --------------------------------------------------- | ------------------------------------------------------------- |
| the token is not checked                            | `no token or a wrong token`, `without a token` (2)            |
| the server keeps working after the deadline         | `deadline shorter than the work … the server stops working`   |
| a cancelled stream keeps its listener (memory leak) | `the client cancels mid-stream …`                             |
| no snapshot before the live updates                 | `a quiet market still answers at once with the snapshot`      |
| every 10th update is dropped                        | `… without gaps …`, `a deadline ends an endless stream` (2)   |
| the buyer pays the bid                              | `buy pays the ask, sell gets the bid of that quote`           |
| duplicate order ids allowed                         | the batch and bidi rejection tests (2)                        |
| order limit off by one (`>=` instead of `>`)        | `1 000 orders pass, 1 001 → RESOURCE_EXHAUSTED`               |
| unknown pair reported as `INVALID_ARGUMENT`         | `NOT_FOUND` tests (2)                                         |
| request id missing from trailers                    | `x-request-id is echoed in the response headers and trailers` |
| USDJPY priced with 5 decimals                       | `a quote has the contract …`                                  |
| no request size limit                               | `a request over 64 KiB → RESOURCE_EXHAUSTED`                  |

12 of 12 caught. The first run missed the snapshot bug: with the feed ticking every 20 ms, live updates arrive in
the same order as a snapshot would. A test on a quiet market, a separate server whose feed does not tick, closed
the gap.

## Limits

- TLS is out of scope for the in-process server (`createInsecure`); a real deployment adds it at the proxy or with
  `ServerCredentials.createSsl`.
- Load testing gRPC (k6 has a gRPC module) is left for later; this suite is about correctness.

## Running

```bash
npm run test:grpc
npm run test:contract
npm run quotes:dev   # :50051, token dev-token, reflection on
grpcurl -plaintext localhost:50051 list
grpcurl -plaintext -H 'authorization: Bearer dev-token' -d '{"pairs":["EURUSD"],"max_updates":5}' \
  localhost:50051 quotes.v1.QuoteService/Subscribe
```
