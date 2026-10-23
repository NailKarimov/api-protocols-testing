# Test plan: quotes over gRPC, WebSocket and SSE (api-protocols-testing)

The structure follows ISO/IEC/IEEE 29119-3 (test plan), shortened for one project.

## 1. Context

- **System under test:** an FX quotes service of our own. It serves one seeded feed over gRPC (unary, server,
  client and bidirectional streaming, health, reflection), WebSocket and Server-Sent Events.
- **Goal:** show that every protocol delivers the same correct prices without gaps or duplicates, even across
  disconnects. Show that the `.proto` contract cannot break silently.
- **References:**
  - gRPC status codes and deadlines;
  - Protocol Buffers compatibility rules (buf);
  - RFC 6455 (WebSocket);
  - the HTML Living Standard, section on server-sent events.

## 2. Scope

| In scope                                                      | Out of scope                     |
| ------------------------------------------------------------- | -------------------------------- |
| all RPCs, status codes, metadata, deadlines, cancellation     | load and soak tests              |
| streaming order, gaps, snapshots                              | TLS termination                  |
| WebSocket and SSE handshakes, resume, heartbeats, close codes | browsers' own EventSource quirks |
| `.proto` breaking changes                                     | other services' contracts        |

## 3. Quality characteristics (ISO/IEC 25010)

| Characteristic                        | Covered by                                                              |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Functional correctness                | quote contracts, exact sums, fills priced at the right side             |
| Compatibility                         | `buf breaking` against an approved snapshot; cross-protocol consistency |
| Reliability (recoverability)          | resume with `since` and `Last-Event-ID`; stale cursors reset            |
| Performance efficiency (resource use) | listeners freed after cancel and close; dead clients dropped            |
| Security                              | tokens checked before the upgrade and on every RPC; size limits         |

## 4. Approach

- **Levels:** protocol-level clients against the service started in-process per worker, on a free port.
- **Techniques:**
  - boundary values: 1 000 and 1 001 orders, 64 KiB, 5 KiB frames;
  - state transitions of connections;
  - a seeded feed, so the same seed gives the same prices;
  - the server's own counters as a second oracle.
- **Test quality:** bugs are planted by hand, one at a time (12 gRPC, 14 realtime). Every one must fail the suite.

## 5. Risks

| Risk                                    | Mitigation                                                       |
| --------------------------------------- | ---------------------------------------------------------------- |
| Timing-dependent streaming tests        | a seeded feed, explicit counts and seq numbers instead of sleeps |
| A contract change slips through         | buf breaking on every push and pull request                      |
| Resource leaks are invisible to clients | assertions on the server's listener counts                       |

## 6. Entry and exit criteria

- **Entry:** lint, format, typecheck and `buf lint` pass.
- **Exit:** all tests pass, no breaking change against the snapshot, and every planted bug is caught.

## 7. Deliverables

The test suite, the Allure report on GitHub Pages, [`test-report.md`](test-report.md) and the two guides.
