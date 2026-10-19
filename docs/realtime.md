# WebSocket and Server-Sent Events: testing live data

Visual version (WebSocket and SSE side by side, a connection that drops and resumes, the heartbeat that finds dead
clients, close codes, the SSE wire format, RU/EN):
[`docs/realtime.html`](https://nailkarimov.github.io/api-protocols-testing/realtime.html).

## Two ways to push data to a client

|                 | WebSocket                                                              | Server-Sent Events (SSE)                                                    |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Direction       | both ways, any time                                                    | server → client only                                                        |
| Starts as       | an HTTP request with `Upgrade: websocket`, then its own frame protocol | an ordinary HTTP GET that never ends                                        |
| Messages        | text or binary frames; the format (here JSON) is up to the app         | text lines: `event:`, `id:`, `data:`, comments `:`                          |
| Reconnect       | the app does it, and decides what to resend                            | built into the browser (`EventSource`), with `Last-Event-ID` and `retry:`   |
| Dead connection | ping / pong frames                                                     | the client notices nothing until a timeout; heartbeat comments help proxies |
| Typical use     | chats, trading terminals, games, collaborative editing                 | notifications, dashboards, LLM token streaming                              |

Both serve the same quote feed as gRPC (`services/quotes/src/feed.ts`), so `cross-protocol.spec` can check that
all three protocols report the same prices for the same `seq`.

## The WebSocket protocol (`/ws`)

- Handshake needs `Authorization: Bearer <token>`, refused with **HTTP 401 before the upgrade**, so a stranger never
  gets a socket. The subprotocol `quotes.v1` must be offered; a client that offers none is closed with **1002**.
- Client → server JSON: `subscribe` (`pairs`, optional `since: { EURUSD: 57 }`), `unsubscribe`, `ping` (`id`).
- Server → client: `subscribed`, `unsubscribed`, `quote`, `reset`, `pong`, `error` (`code`, `message`).
- A bad message gets an `error` and the connection stays; the **5th** bad message closes with **1008** (policy
  violation). A frame over **4 KiB** closes with **1009** (message too big).
- The server pings every heartbeat (200 ms in tests, 15 s by default). A client that did not answer the previous
  ping is terminated, which is how half-open connections (a phone in a tunnel) are found.
- Reconnecting with `since` replays exactly what was missed from the history (1 000 quotes per pair). A `since`
  older than the history gets `reset` and a fresh snapshot, never a silent gap.
- Shutdown closes every client with **1001** (going away).

## The SSE stream (`GET /sse?pairs=EURUSD,USDJPY`)

```
retry: 1000

event: quote
id: EURUSD=5,USDJPY=0
data: {"type":"quote","pair":"EURUSD","bid":"1.08484","ask":"1.08507","seq":5,"time":"…"}

: ping
```

- `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no` (so nginx does not buffer).
- `retry:` tells the browser how long to wait before reconnecting.
- The `id` is a **cursor of every pair**, not just the pair of the event: one `Last-Event-ID` header must be enough
  to resume all of them.
- Reconnecting with `Last-Event-ID` resumes without a gap or a repeat; a cursor older than the history gets
  `event: reset`; a malformed one is a 400.
- Errors (no token 401, `Accept` without `text/event-stream` 406, bad pairs 400, unknown pair 404) are JSON, not a
  stream.
- Heartbeat comments keep idle connections alive through proxies that cut silent ones.

## What the tests check (32)

| Spec                  | Technique                             | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `websocket.spec` (19) | Protocol, negative, state, resilience | ack, snapshot, quotes without gaps; 401 and 404 handshakes; subprotocol rules (another one fails, none → 1002); app ping/pong; 6 bad messages answered with an error while the socket stays usable; 5th → 1008; 5 KiB frame → 1009; unsubscribe really stops a pair; **drop and resume with `since`: the first replayed seq is last + 1**; stale `since` → reset; a client that never pongs is dropped (1006) while a healthy one stays; shutdown → 1001; **20 clients see identical prices per seq**; closed clients free their server-side listeners |
| `sse.spec` (12)       | Protocol, negative, resilience        | SSE headers, `retry` first, snapshot, no gaps; the id cursor names every pair; **resume with `Last-Event-ID`: nothing missed, nothing twice**; stale cursor → reset; heartbeat comments; 5 refusals as JSON (401, 406, 400, 404, bad cursor 400); closed tabs free their listeners; shutdown ends the stream                                                                                                                                                                                                                                           |
| `cross-protocol.spec` | Consistency across interfaces         | gRPC, WebSocket and SSE subscribed at once: identical bid/ask for every common seq                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Clients: `src/realtime/WsClient.ts` (on the `ws` library: keeps every message and event in order, can drop the TCP
connection without a close frame, can turn off automatic pongs) and `src/realtime/SseClient.ts` (on `fetch`:
parses the stream exactly as the EventSource specification says, keeps `Last-Event-ID`). Each connection's
transcript is attached to the Allure report with the token masked. Waiting is done by condition
(`until(() => quotes >= 30)`), never by a fixed sleep, except where the test is about time passing (the market
moving while a client is away).

## Do the tests catch real bugs?

| Planted bug                                       | Caught by                                                  |
| ------------------------------------------------- | ---------------------------------------------------------- |
| SSE ignores `Last-Event-ID`                       | the SSE resume and reset tests (2)                         |
| WebSocket ignores `since`                         | the WebSocket resume and reset tests (2)                   |
| the SSE id names only the last pair               | `every event id is a cursor of all pairs`, resume (2)      |
| silent WebSocket clients are never dropped        | `heartbeat: a client that never answers pings is dropped`  |
| a closed SSE tab keeps its listener (leak)        | `a closed tab releases the server-side subscription`       |
| a closed WebSocket keeps its listener (leak)      | `closed clients release their subscriptions on the server` |
| bad messages never close the socket               | `the 5th bad message closes the connection with 1008`      |
| the handshake skips authentication                | `handshake without a token → HTTP 401`                     |
| `unsubscribe` does nothing                        | `unsubscribe: no more quotes of that pair`                 |
| SSE without heartbeats                            | `heartbeat comments keep an idle connection alive`         |
| SSE served as `text/plain`                        | 8 tests                                                    |
| no 1001 on shutdown                               | `server shutdown: clients get 1001 going away`             |
| WebSocket replays a stale `since` without a reset | `since older than the history → reset`                     |
| no frame size limit                               | `a frame over 4 KiB closes the connection with 1009`       |

14 of 14 caught.

## Limits

- Backpressure (a client too slow to read) and load (thousands of sockets) are not covered here; k6 has a
  WebSocket module for that.
- Browsers' `EventSource` cannot send an `Authorization` header. A browser client would use a cookie or a
  short-lived ticket in the URL; this service is tested with a fetch-based client that can.
- TLS (`wss://`, `https://`) is left to the proxy in front of the service.

## Running

```bash
npm run test:realtime
npm run quotes:dev     # WebSocket and SSE on :8080, token dev-token
curl -N -H 'Authorization: Bearer dev-token' 'http://localhost:8080/sse?pairs=EURUSD,USDJPY'
websocat -H 'Authorization: Bearer dev-token' --protocol quotes.v1 ws://localhost:8080/ws
```
