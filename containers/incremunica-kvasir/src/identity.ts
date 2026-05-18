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
  const rowScope = canonicalBindingKey(entries);

  for (const [variable, term] of entries) {
    if (typeof variable.value !== "string") continue;
    if (!STABLE_ID_VARIABLES.has(variable.value)) continue;
    if (typeof term.value !== "string" || term.value.length === 0) continue;

    const termType = typeof term.termType === "string" ? term.termType : "term";
    if (termType === "Literal") {
      return {
        key: ["stable", sourceScope, variable.value, termType, term.value].join("|"),
        stable: true,
      };
    }

    return {
      key: ["row", sourceScope, rowScope].join("|"),
      stable: true,
    };
  }

  return {
    key: ["row", sourceScope, rowScope].join("|"),
    stable: false,
  };
}

function canonicalBindingKey(entries: [BindingVariable, BindingTerm][]): string {
  const rows = entries.map(([variable, term]) => [
    typeof variable.value === "string" ? variable.value : "",
    typeof term.termType === "string" ? term.termType : "",
    typeof term.value === "string" ? term.value : "",
    typeof term.datatype?.value === "string" ? term.datatype.value : "",
    typeof term.language === "string" ? term.language : "",
  ]);

  rows.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(rows);
}
