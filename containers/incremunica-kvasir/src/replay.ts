export interface ReplayAdditionDecision {
  replaySeenCount: number;
  shouldMaterialize: boolean;
}

export interface ReplaySnapshot {
  rows: number;
  seen: Map<string, number>;
}

export function recordReplayAddition(
  seen: Map<string, number>,
  key: string,
  currentSourceCount: number,
): ReplayAdditionDecision {
  const replaySeenCount = (seen.get(key) ?? 0) + 1;
  seen.set(key, replaySeenCount);

  return {
    replaySeenCount,
    shouldMaterialize: replaySeenCount > currentSourceCount,
  };
}

export function replayRowCount(seen: Map<string, number>): number {
  let rows = 0;
  for (const count of seen.values()) rows += count;
  return rows;
}

export function copyReplaySnapshot(seen: Map<string, number>): ReplaySnapshot {
  return {
    rows: replayRowCount(seen),
    seen: new Map(seen),
  };
}

export function replaySnapshotsEqual(left?: ReplaySnapshot, right?: ReplaySnapshot): boolean {
  if (!left || !right) return false;
  if (left.rows !== right.rows) return false;
  if (left.seen.size !== right.seen.size) return false;

  for (const [key, count] of left.seen) {
    if (right.seen.get(key) !== count) return false;
  }

  return true;
}
