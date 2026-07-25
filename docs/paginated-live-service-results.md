# Paginated snapshots and append-only service results

The `incremunica-kvasir` transformation maintains a materialized SPARQL result
for each generated aggregator service. PACSOI observations are immutable and
append-only, so clients do not need the complete view after every update.

## Readiness boundary

Incremunica first evaluates a paginated static GraphQL query against every
configured Kvasir source. It opens the Kvasir subscription only after the last
static page has been consumed. The generated service uses the first successful
subscription request for every source as its readiness signal.

Before that boundary, result requests return `503 Service Unavailable`.
Clients avoid repeatedly requesting the result by checking the constant-size
readiness document:

```http
GET /<aggregator-id>/<service>/<output>?mode=status
Accept: application/json
```

While the view is being constructed it returns
`{"ready":false,"rows":null,"sequence":0}`. Once `ready` becomes `true`, the
client requests the first snapshot page. The readiness handler does not iterate
or serialize the materialized view. Initial bindings are placed in the
snapshot and are not published as live additions. After readiness, every
addition receives a monotonically increasing service-local sequence number.

## Initial snapshot

Request the service output with an optional page size:

```http
GET /<aggregator-id>/<service>/<output>?pageSize=25000
Accept: application/sparql-results+json
```

The response is standard SPARQL JSON plus pagination metadata:

```json
{
  "head": { "vars": ["observation", "value"] },
  "results": { "bindings": [] },
  "extensions": {
    "pagination": {
      "snapshot": "snapshot-id",
      "snapshotSequence": 0,
      "nextCursor": "opaque-cursor-or-null",
      "returnedRows": 25000,
      "totalRows": 1200000,
      "expiresAt": "2026-07-24T12:00:00.000Z"
    }
  }
}
```

Pass `nextCursor` unchanged as `cursor` until it becomes `null`. A cursor is
bound to one consistent snapshot. It returns `410 Gone` after its snapshot has
expired. Snapshot expiry is an idle timeout and is extended whenever the next
page is read.

## Live additions

After all snapshot pages have been consumed, open the SSE output from the
snapshot sequence:

```http
GET /<aggregator-id>/<service>/<output>?mode=changes&after=0
Accept: text/event-stream
Last-Event-ID: 0
```

An addition has this form:

```text
id: 1
event: add
data: {"sequence":1,"source":"https://pod/slices/data/query","count":1,"binding":{}}
```

Clients retain the last successfully processed sequence and use it as `after`
when reconnecting. The generated service replays retained events. It returns
`410 Gone` when the requested sequence is older than the replay window; a
client must then discard its local result and obtain a fresh snapshot.
Sequence gaps must never be ignored.

## Configuration

The generated container accepts these environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `RESULT_PAGE_SIZE` | `100000` | Default snapshot page size |
| `RESULT_MAX_PAGE_SIZE` | `500000` | Maximum accepted page size |
| `RESULT_SNAPSHOT_TTL_MS` | `300000` | Snapshot idle timeout |
| `RESULT_MAX_SNAPSHOTS` | `2` | Concurrent retained snapshots |
| `RESULT_REPLAY_LIMIT` | `2000000` | Retained addition events |
| `RESULT_HEARTBEAT_MS` | `15000` | SSE heartbeat interval |
| `INITIAL_VIEW_SETTLE_MS` | `30000` | Quiet period after all source subscriptions open before the initial view is declared ready |

The aggregator proxy preserves the query string and flushes SSE chunks
immediately. UMA clients cache one RPT per HTTP method and protected resource
path, so page cursors and SSE reconnect parameters do not cause a new ticket
exchange for every request.

The automation defaults to `result_mode: snapshot-and-stream`. It polls only
the readiness document while the initial view is loading, at the configured
`poll_interval` bounded to 5--30 seconds. Its `result_page_size` controls
snapshot pages, while `poll_interval` also controls how often cumulative stream
summaries are written. The dashboard checks readiness every five seconds. It
then follows the same snapshot-and-stream protocol and keeps only a bounded
recent sample window in browser memory.
