# Paginated snapshots and append-only service results

The `incremunica-kvasir` transformation maintains a materialized SPARQL result
for each generated aggregator service. PACSOI observations are immutable and
append-only, so clients do not need the complete view after every update.

## Readiness boundary

Incremunica first evaluates a paginated static GraphQL query against every
configured Kvasir source. It opens the Kvasir subscription only after the last
static page has been consumed. The generated service uses the first successful
subscription request for every source as its readiness signal.

Before that boundary, result requests return `503 Service Unavailable` with a
`Retry-After: 2` header. Initial bindings are placed in the snapshot and are not
published as live additions. After readiness, every addition receives a
monotonically increasing service-local sequence number.

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
| `RESULT_PAGE_SIZE` | `25000` | Default snapshot page size |
| `RESULT_MAX_PAGE_SIZE` | `50000` | Maximum accepted page size |
| `RESULT_SNAPSHOT_TTL_MS` | `300000` | Snapshot idle timeout |
| `RESULT_MAX_SNAPSHOTS` | `4` | Concurrent retained snapshots |
| `RESULT_REPLAY_LIMIT` | `100000` | Retained addition events |
| `RESULT_HEARTBEAT_MS` | `15000` | SSE heartbeat interval |

The aggregator proxy preserves the query string and flushes SSE chunks
immediately. UMA clients cache one RPT per HTTP method and protected resource
path, so page cursors and SSE reconnect parameters do not cause a new ticket
exchange for every request.

The automation defaults to `result_mode: snapshot-and-stream`. Its
`result_page_size` controls snapshot pages, while `poll_interval` controls how
often cumulative stream summaries are written. The dashboard follows the same
snapshot-and-stream protocol and keeps only a bounded recent sample window in
browser memory.
