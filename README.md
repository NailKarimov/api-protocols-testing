# api-protocols-testing

[![Tests](https://github.com/NailKarimov/api-protocols-testing/actions/workflows/tests.yml/badge.svg)](https://github.com/NailKarimov/api-protocols-testing/actions/workflows/tests.yml)
[![Allure report](https://img.shields.io/badge/report-Allure-orange)](https://nailkarimov.github.io/api-protocols-testing/)
[![Release](https://img.shields.io/github/v/release/NailKarimov/api-protocols-testing)](https://github.com/NailKarimov/api-protocols-testing/releases)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/NailKarimov/api-protocols-testing?quickstart=1)

### ▶ Open online

| Page                                                                                   | What it is        |
| -------------------------------------------------------------------------------------- | ----------------- |
| **[Allure test report](https://nailkarimov.github.io/api-protocols-testing/)**         | latest CI run     |
| [gRPC](https://nailkarimov.github.io/api-protocols-testing/grpc.html)                  | interactive guide |
| [WebSocket and SSE](https://nailkarimov.github.io/api-protocols-testing/realtime.html) | interactive guide |

Click these links: opening an `.html` file in the file list shows its source code, GitHub does not run it.

Testing APIs beyond REST. One FX quotes service of our own serves the same live feed over **gRPC**,
**WebSocket** and **Server-Sent Events**, so the tests can compare the three protocols on the same data.

|                        |                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System under test**  | own quotes service (`services/quotes`): a seeded random-walk feed; gRPC with all four call kinds, health and reflection; WebSocket `/ws` and SSE `/sse`                                                                            |
| **Language and tools** | TypeScript · Playwright Test · `@grpc/grpc-js` · Protocol Buffers · buf · `ws` · zod · Allure                                                                                                                                      |
| **Types of testing**   | functional API (gRPC, WebSocket, SSE), contract (`.proto` breaking changes), streaming, resilience (resume, heartbeats)                                                                                                            |
| **Tests**              | 79: 47 gRPC, 32 WebSocket and SSE                                                                                                                                                                                                  |
| **Test quality**       | 26/26 planted bugs caught: 12 in gRPC, 14 in WebSocket and SSE                                                                                                                                                                     |
| **Reports**            | [Allure](https://nailkarimov.github.io/api-protocols-testing/) · [gRPC guide](https://nailkarimov.github.io/api-protocols-testing/grpc.html) · [realtime guide](https://nailkarimov.github.io/api-protocols-testing/realtime.html) |

## What is tested

| Suite                     | Tool      | What it proves                                                                                                                                                                                                                             |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grpc/unary`              | grpc-js   | the quote contract (5 decimals, 3 for JPY; bid < ask; fresh time); status codes INVALID_ARGUMENT, NOT_FOUND, UNAUTHENTICATED, RESOURCE_EXHAUSTED, UNIMPLEMENTED; deadlines stop the abandoned work; the request id in headers and trailers |
| `grpc/streaming`          | grpc-js   | server stream: a snapshot, then updates with no seq gaps, cancel frees the listener. Client stream: exact sums, 1 000 / 1 001 orders. Bidi: fills at the right side of the quote                                                           |
| `grpc/health-reflection`  | grpc-js   | `grpc.health.v1` states, public without a token; reflection describes the API without the `.proto`                                                                                                                                         |
| `contract/proto-breaking` | buf       | the `.proto` matches the approved snapshot; 8 typical breaking edits are caught, adding a field passes                                                                                                                                     |
| `realtime/websocket`      | ws        | 401 before the upgrade, subprotocol, no seq gaps, bad messages and close codes 1002 / 1008 / 1009 / 1001, **drop and resume with `since`**, dead clients dropped by heartbeat, 20 clients see identical prices                             |
| `realtime/sse`            | fetch     | headers, `retry`, a cursor id, **resume with `Last-Event-ID`**, heartbeat comments, JSON errors, closed tabs free their listeners                                                                                                          |
| `realtime/cross-protocol` | all three | gRPC, WebSocket and SSE report the same bid / ask for every common seq                                                                                                                                                                     |

## Findings

- **buf lint found a design issue on day one.** Several RPCs shared request and response messages, so none of
  them could evolve on its own. Each RPC now has its own messages.
- **Resume is the hard part of realtime.** The planted bugs that ignored `since` or used a cursor naming one pair
  passed every connect test. Only the drop-and-resume tests caught them.
- **Leaks are invisible to the client.** Leaked stream listeners never showed in an answer. The tests read the
  server's listener count after cancel and close.

## Running it

No local setup: the **Open in GitHub Codespaces** badge starts a browser VS Code with this repository, its tools and Docker; the container runs `npm ci` on creation, then `npm test` works in the terminal.

Requirements: Node.js 22+, the buf CLI for contract checks, Java 17+ for a local Allure report. No Docker needed.

```bash
npm ci
npm test                 # everything; every worker starts its own service on a free port
npm run test:grpc        # gRPC only
npm run test:realtime    # WebSocket and SSE
npm run test:contract    # buf breaking against contracts/quotes.v1.binpb
npm run proto:lint       # buf lint + format check
npm run quotes:dev       # gRPC :50051, WebSocket and SSE :8080, token dev-token
```

A deliberate contract change: edit the `.proto`, run `npm run proto:approve`, and commit both files.

## Project structure

```text
proto/quotes/v1/       the .proto contract
contracts/             the approved snapshot (quotes.v1.binpb) for buf breaking
services/quotes/       the system under test: feed, gRPC server, HTTP server with /ws and /sse
src/grpc/, src/realtime/   clients and helpers for the tests
src/fixtures.ts        a service per worker
tests/grpc/            gRPC specs
tests/realtime/        WebSocket, SSE and cross-protocol specs
tests/contract/        proto breaking-change spec
docs/                  test plan, test report, guides
```

## CI

`.github/workflows/tests.yml` runs on push, pull request, nightly at 03:00 UTC and on demand:

- lint, format and typecheck, then `buf lint` and `buf breaking`;
- all tests, then the Allure report with history on GitHub Pages.

Releases: committing `.github/releases/<tag>.md` runs the Release workflow, which creates the tag and the GitHub release with that file as its notes.

## Documentation

| Document                                                                                                             | What it is                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`docs/test-plan.md`](docs/test-plan.md)                                                                             | test plan (ISO/IEC/IEEE 29119-3)                                                        |
| [`docs/test-report.md`](docs/test-report.md)                                                                         | test summary report: latest results, findings, recommendations                          |
| [`docs/grpc.md`](docs/grpc.md) · [visual](https://nailkarimov.github.io/api-protocols-testing/grpc.html)             | gRPC: four call kinds, status codes, deadlines, breaking `.proto` changes, planted bugs |
| [`docs/realtime.md`](docs/realtime.md) · [visual](https://nailkarimov.github.io/api-protocols-testing/realtime.html) | WebSocket and SSE: resume without gaps, heartbeats, close codes, planted bugs           |

## Part of a portfolio

One of 13 test automation projects by [Nail Karimov](https://github.com/NailKarimov):
[all projects](https://github.com/NailKarimov) ·
[testing map](https://nailkarimov.github.io/api-test-automation/testing-map.html) ·
[toolbox](https://nailkarimov.github.io/api-test-automation/toolbox.html).
