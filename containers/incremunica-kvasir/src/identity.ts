interface BindingVariable {
  value?: unknown;
}

interface BindingTerm {
  termType?: unknown;
  value?: unknown;
  datatype?: { value?: unknown };
  language?: unknown;
}

type BindingLike = Iterable<[BindingVariable, BindingTerm]> & {
  toString(): string;
};

export interface MaterializedBindingKey {
  key: string;
  stable: boolean;
}

const STABLE_ID_VARIABLES = new Set(["obs", "id"]);

export function materializedBindingKey(binding: BindingLike, source?: string): MaterializedBindingKey {
  const sourceScope = source ?? "unknown-source";
  const entries = Array.from(binding);

  for (const [variable, term] of entries) {
    const variableName = normalizeVariableName(variable.value);
    if (!variableName || !STABLE_ID_VARIABLES.has(variableName)) continue;
    if (typeof term.value !== "string" || term.value.length === 0) continue;

    const termType = typeof term.termType === "string" ? term.termType : "term";
    return {
      key: ["stable", sourceScope, variableName, termType, term.value].join("|"),
      stable: true,
    };
  }

  return {
    key: ["row", sourceScope, canonicalBindingKey(entries)].join("|"),
    stable: false,
  };
}

function normalizeVariableName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const withoutPrefix = value.replace(/^[?$]+/, "");
  const hashIndex = withoutPrefix.lastIndexOf("#");
  const slashIndex = withoutPrefix.lastIndexOf("/");
  const localIndex = Math.max(hashIndex, slashIndex);
  return localIndex >= 0 ? withoutPrefix.slice(localIndex + 1) : withoutPrefix;
}

function canonicalBindingKey(entries: [BindingVariable, BindingTerm][]): string {
  const rows = entries.map(([variable, term]) => [
    normalizeVariableName(variable.value) ?? "",
    typeof term.termType === "string" ? term.termType : "",
    typeof term.value === "string" ? term.value : "",
    typeof term.datatype?.value === "string" ? term.datatype.value : "",
    typeof term.language === "string" ? term.language : "",
  ]);

  rows.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(rows);
}
