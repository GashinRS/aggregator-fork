interface BindingVariable {
  value?: unknown;
}

interface BindingTerm {
  termType?: unknown;
  value?: unknown;
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
  for (const [variable, term] of binding) {
    if (typeof variable.value !== "string") continue;
    if (!STABLE_ID_VARIABLES.has(variable.value)) continue;
    if (typeof term.value !== "string" || term.value.length === 0) continue;

    const termType = typeof term.termType === "string" ? term.termType : "term";
    const sourceScope = source ?? "unknown-source";
    const rowScope = termType === "NamedNode" ? binding.toString() : "";
    return {
      key: ["stable", sourceScope, variable.value, termType, term.value, rowScope].join("|"),
      stable: true,
    };
  }

  return {
    key: binding.toString(),
    stable: false,
  };
}
