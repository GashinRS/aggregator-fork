import { randomUUID } from "node:crypto";

export interface SparqlBindingValue {
  type: "literal" | "uri" | "bnode";
  value: string;
  datatype?: string;
  "xml:lang"?: string;
}

export type SparqlResultRow = Record<string, SparqlBindingValue>;

export interface MaterializedEntry {
  bindings: any;
  count: number;
}

export interface AdditionEvent {
  sequence: number;
  source?: string;
  count: number;
  binding: SparqlResultRow;
  createdAt: string;
}

interface Snapshot {
  id: string;
  sequence: number;
  variables: string[];
  bindings: any[];
  counts: number[];
  totalRows: number;
  expiresAt: number;
}

interface CursorPayload {
  snapshot: string;
  entry: number;
  occurrence: number;
}

export interface SnapshotPage {
  head: { vars: string[] };
  results: { bindings: SparqlResultRow[] };
  extensions: {
    pagination: {
      snapshot: string;
      snapshotSequence: number;
      nextCursor: string | null;
      returnedRows: number;
      totalRows: number;
      expiresAt: string;
    };
  };
}

export class LiveResultError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export function bindingToSparqlResult(bindings: any): SparqlResultRow {
  const result: SparqlResultRow = {};

  for (const [variable, value] of bindings) {
    const variableName = variable.value;
    if (value.termType === "Literal") {
      result[variableName] = {
        type: "literal",
        value: value.value,
      };
      if (value.datatype) {
        result[variableName].datatype = value.datatype.value;
      }
      if (value.language) {
        result[variableName]["xml:lang"] = value.language;
      }
    } else if (value.termType === "NamedNode") {
      result[variableName] = {
        type: "uri",
        value: value.value,
      };
    } else if (value.termType === "BlankNode") {
      result[variableName] = {
        type: "bnode",
        value: value.value,
      };
    }
  }

  return result;
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      typeof parsed.snapshot !== "string" ||
      !Number.isInteger(parsed.entry) ||
      !Number.isInteger(parsed.occurrence) ||
      (parsed.entry ?? -1) < 0 ||
      (parsed.occurrence ?? -1) < 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed as CursorPayload;
  } catch {
    throw new LiveResultError("Invalid result cursor", 400);
  }
}

/**
 * Stores only compact snapshot rows and a bounded tail of append-only additions.
 * It deliberately does not retain removal events: PACSOI observations are immutable.
 */
export class LiveResultStore {
  private sequence = 0;
  private readonly replay: AdditionEvent[] = [];
  private replayStart = 0;
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly subscribers = new Map<number, (event: AdditionEvent) => boolean>();
  private nextSubscriber = 1;

  constructor(
    private readonly replayLimit = 2_000_000,
    private readonly snapshotTtlMs = 5 * 60_000,
    private readonly maxSnapshots = 2,
  ) {}

  currentSequence(): number {
    return this.sequence;
  }

  recordAddition(bindings: any, source?: string, count = 1): AdditionEvent {
    const event: AdditionEvent = {
      sequence: ++this.sequence,
      source,
      count,
      binding: bindingToSparqlResult(bindings),
      createdAt: new Date().toISOString(),
    };

    this.replay.push(event);
    if (this.replay.length - this.replayStart > this.replayLimit) {
      this.replayStart++;
    }
    // Compact in large batches instead of shifting a 100k-entry array for
    // every observation after the replay limit has been reached.
    if (
      this.replayStart >= this.replayLimit &&
      this.replayStart * 2 >= this.replay.length
    ) {
      this.replay.splice(0, this.replayStart);
      this.replayStart = 0;
    }

    for (const [id, send] of this.subscribers) {
      if (!send(event)) {
        this.subscribers.delete(id);
      }
    }
    return event;
  }

  createSnapshot(view: Map<string, MaterializedEntry>): Snapshot {
    this.cleanupSnapshots();

    const variables = new Set<string>();
    const bindings: any[] = [];
    const counts: number[] = [];
    let totalRows = 0;

    for (const element of view.values()) {
      for (const variable of element.bindings.keys()) {
        variables.add(variable.value);
      }
      // Bindings are immutable for append-only observations. Retaining the
      // reference keeps a snapshot compact and delays JSON conversion until
      // the corresponding page is requested.
      bindings.push(element.bindings);
      counts.push(element.count);
      totalRows += element.count;
    }

    const snapshot: Snapshot = {
      id: randomUUID(),
      sequence: this.sequence,
      variables: [...variables],
      bindings,
      counts,
      totalRows,
      expiresAt: Date.now() + this.snapshotTtlMs,
    };
    this.snapshots.set(snapshot.id, snapshot);

    while (this.snapshots.size > this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest);
    }
    return snapshot;
  }

  firstPage(view: Map<string, MaterializedEntry>, pageSize: number): SnapshotPage {
    return this.pageFrom(this.createSnapshot(view), { entry: 0, occurrence: 0 }, pageSize);
  }

  nextPage(cursorValue: string, pageSize: number): SnapshotPage {
    this.cleanupSnapshots();
    const cursor = decodeCursor(cursorValue);
    const snapshot = this.snapshots.get(cursor.snapshot);
    if (!snapshot) {
      throw new LiveResultError("Result snapshot expired; fetch a new initial snapshot", 410);
    }
    // Treat the TTL as an idle timeout. A large but actively consumed snapshot
    // must not expire halfway through its page sequence.
    snapshot.expiresAt = Date.now() + this.snapshotTtlMs;
    this.snapshots.delete(snapshot.id);
    this.snapshots.set(snapshot.id, snapshot);
    return this.pageFrom(snapshot, cursor, pageSize);
  }

  /**
   * Register before returning replay events. JavaScript executes this method and the
   * caller's immediate replay writes synchronously, so live events cannot slip into
   * the snapshot-to-subscription gap.
   */
  subscribe(
    after: number,
    send: (event: AdditionEvent) => boolean,
  ): { replay: AdditionEvent[]; unsubscribe: () => void } {
    if (!Number.isInteger(after) || after < 0) {
      throw new LiveResultError("The changes cursor must be a non-negative integer", 400);
    }
    if (after > this.sequence) {
      throw new LiveResultError("The changes cursor is ahead of the current service sequence", 400);
    }

    const oldestAvailable = this.replay[this.replayStart]?.sequence ?? this.sequence + 1;
    if (after < this.sequence && after < oldestAvailable - 1) {
      throw new LiveResultError("Change replay expired; fetch a new initial snapshot", 410);
    }

    const id = this.nextSubscriber++;
    this.subscribers.set(id, send);
    return {
      replay: this.replay
        .slice(this.replayStart)
        .filter((event) => event.sequence > after),
      unsubscribe: () => {
        this.subscribers.delete(id);
      },
    };
  }

  private pageFrom(
    snapshot: Snapshot,
    position: { entry: number; occurrence: number },
    pageSize: number,
  ): SnapshotPage {
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new LiveResultError("pageSize must be a positive integer", 400);
    }

    const bindings: SparqlResultRow[] = [];
    let entry = position.entry;
    let occurrence = position.occurrence;

    while (entry < snapshot.bindings.length && bindings.length < pageSize) {
      const currentBindings = snapshot.bindings[entry];
      const currentCount = snapshot.counts[entry] ?? 0;
      if (!currentBindings || occurrence >= currentCount) {
        entry++;
        occurrence = 0;
        continue;
      }

      bindings.push(bindingToSparqlResult(currentBindings));
      occurrence++;
      if (occurrence >= currentCount) {
        entry++;
        occurrence = 0;
      }
    }

    const done = entry >= snapshot.bindings.length;
    return {
      head: { vars: snapshot.variables },
      results: { bindings },
      extensions: {
        pagination: {
          snapshot: snapshot.id,
          snapshotSequence: snapshot.sequence,
          nextCursor: done
            ? null
            : encodeCursor({ snapshot: snapshot.id, entry, occurrence }),
          returnedRows: bindings.length,
          totalRows: snapshot.totalRows,
          expiresAt: new Date(snapshot.expiresAt).toISOString(),
        },
      },
    };
  }

  private cleanupSnapshots(): void {
    const now = Date.now();
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) this.snapshots.delete(id);
    }
  }
}
