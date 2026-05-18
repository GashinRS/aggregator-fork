export interface ReplayAdditionDecision {
  replaySeenCount: number;
  shouldMaterialize: boolean;
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
