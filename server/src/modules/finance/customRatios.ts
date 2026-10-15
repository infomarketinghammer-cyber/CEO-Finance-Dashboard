/**
 * Custom ratio builder — §17 of the implementation brief:
 *   "Allow authorized users to create custom ratios by selecting supported
 *    financial inputs and defining a formula."
 *
 * Two deliberate design choices:
 *
 *  1. Formulas are parsed by the small recursive-descent parser below, never by
 *     `eval` or `new Function`. A formula is user-supplied data that is stored
 *     and later executed server-side; handing it to a JavaScript evaluator would
 *     be remote code execution against the finance server. The grammar accepts
 *     only numbers, the named inputs published by `RATIO_INPUTS`, the four
 *     arithmetic operators and parentheses.
 *
 *  2. An input that the imported data cannot supply evaluates to `null`, and
 *     `null` propagates through the whole expression, so the ratio reports
 *     "N/A" with a reason rather than a misleading zero (§10).
 */
import { RATIO_INPUTS, type RatioInputKey } from './ratioInputs.js';
import type { RatioResult, RatioUnit } from './ratios.js';

export interface CustomRatioDefinition {
  key: string;
  label: string;
  formula: string;
  unit: RatioUnit;
  /** Author's note on what the ratio is meant to show. Shown with the result. */
  explanation: string;
  group: 'liquidity' | 'profitability' | 'efficiency' | 'leverage';
}

/* ------------------------------------------------------------------ tokens */

type Token =
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' }
  | { type: 'lparen' }
  | { type: 'rparen' };

export class FormulaError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }

    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      let j = i;
      let seenDot = false;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || (src[j] === '.' && !seenDot))) {
        if (src[j] === '.') seenDot = true;
        j += 1;
      }
      const raw = src.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new FormulaError(`"${raw}" is not a usable number.`);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }

    throw new FormulaError(`"${ch}" cannot be used in a formula. Use the listed inputs, numbers, + - * / and brackets.`);
  }

  if (!tokens.length) throw new FormulaError('The formula is empty.');
  return tokens;
}

/* ------------------------------------------------------------------- parse */

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; name: string }
  | { kind: 'neg'; operand: Node }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: Node; right: Node };

const VALID_KEYS = new Set<string>(RATIO_INPUTS.map((i) => i.key));

/**
 * expr   := term (('+' | '-') term)*
 * term   := factor (('*' | '/') factor)*
 * factor := '-' factor | primary
 * primary:= number | identifier | '(' expr ')'
 */
function parse(tokens: Token[]): Node {
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];

  function expr(): Node {
    let left = term();
    for (;;) {
      const t = peek();
      if (t?.type === 'op' && (t.value === '+' || t.value === '-')) {
        pos += 1;
        left = { kind: 'bin', op: t.value, left, right: term() };
      } else {
        return left;
      }
    }
  }

  function term(): Node {
    let left = factor();
    for (;;) {
      const t = peek();
      if (t?.type === 'op' && (t.value === '*' || t.value === '/')) {
        pos += 1;
        left = { kind: 'bin', op: t.value, left, right: factor() };
      } else {
        return left;
      }
    }
  }

  function factor(): Node {
    const t = peek();
    if (t?.type === 'op' && t.value === '-') {
      pos += 1;
      return { kind: 'neg', operand: factor() };
    }
    return primary();
  }

  function primary(): Node {
    const t = peek();
    if (!t) throw new FormulaError('The formula ends unexpectedly — something is missing after the last operator.');

    if (t.type === 'number') {
      pos += 1;
      return { kind: 'num', value: t.value };
    }

    if (t.type === 'ident') {
      pos += 1;
      if (!VALID_KEYS.has(t.value)) {
        throw new FormulaError(`"${t.value}" is not an available financial input. Pick one from the list of supported inputs.`);
      }
      return { kind: 'ref', name: t.value };
    }

    if (t.type === 'lparen') {
      pos += 1;
      const inner = expr();
      const close = peek();
      if (close?.type !== 'rparen') throw new FormulaError('A bracket was opened but never closed.');
      pos += 1;
      return inner;
    }

    throw new FormulaError('A value or bracket was expected here.');
  }

  const tree = expr();
  if (pos !== tokens.length) throw new FormulaError('There is unexpected text after the end of the formula.');
  return tree;
}

/** Parses and validates a formula without evaluating it. Throws FormulaError. */
export function compileFormula(formula: string): Node {
  return parse(tokenize(formula));
}

/** The input keys a formula actually reads, for showing sources alongside the result. */
export function referencedInputs(node: Node, into: Set<string> = new Set()): Set<string> {
  if (node.kind === 'ref') into.add(node.name);
  else if (node.kind === 'neg') referencedInputs(node.operand, into);
  else if (node.kind === 'bin') {
    referencedInputs(node.left, into);
    referencedInputs(node.right, into);
  }
  return into;
}

/* ---------------------------------------------------------------- evaluate */

interface EvalOutcome {
  value: number | null;
  reason?: string;
}

function evaluate(node: Node, values: Record<string, number | null>): EvalOutcome {
  switch (node.kind) {
    case 'num':
      return { value: node.value };

    case 'ref': {
      const v = values[node.name];
      if (v === null || v === undefined) {
        const label = RATIO_INPUTS.find((i) => i.key === node.name)?.label ?? node.name;
        return { value: null, reason: `${label} is not available from the imported data.` };
      }
      return { value: v };
    }

    case 'neg': {
      const inner = evaluate(node.operand, values);
      return inner.value === null ? inner : { value: -inner.value };
    }

    case 'bin': {
      const l = evaluate(node.left, values);
      if (l.value === null) return l;
      const r = evaluate(node.right, values);
      if (r.value === null) return r;

      switch (node.op) {
        case '+':
          return { value: l.value + r.value };
        case '-':
          return { value: l.value - r.value };
        case '*':
          return { value: l.value * r.value };
        case '/':
          // §17: "Prevent division-by-zero errors. Display N/A."
          if (r.value === 0) return { value: null, reason: 'The divisor works out to zero, so the ratio cannot be calculated.' };
          return { value: l.value / r.value };
      }
    }
  }
}

/**
 * Evaluates every saved custom ratio against the period's financial inputs.
 * A definition that no longer parses (because it was hand-edited in settings,
 * say) is reported as unavailable rather than throwing the whole report away.
 */
export function evaluateCustomRatios(
  definitions: CustomRatioDefinition[],
  values: Record<string, number | null>,
): RatioResult[] {
  return definitions.map((def) => {
    let tree: Node;
    try {
      tree = compileFormula(def.formula);
    } catch (err) {
      return {
        key: def.key,
        label: def.label,
        group: def.group,
        value: null,
        unit: def.unit,
        formula: def.formula,
        inputs: [],
        available: false,
        reason: `This custom formula can no longer be read: ${(err as Error).message}`,
        explanation: def.explanation,
        isCustom: true,
      } as RatioResult;
    }

    const used = [...referencedInputs(tree)];
    const outcome = evaluate(tree, values);

    return {
      key: def.key,
      label: def.label,
      group: def.group,
      value: outcome.value,
      unit: def.unit,
      formula: def.formula,
      inputs: used.map((k) => {
        const meta = RATIO_INPUTS.find((i) => i.key === k)!;
        return {
          label: meta.label,
          value: values[k] ?? null,
          unit: meta.kind === 'money' ? ('money' as const) : ('number' as const),
          source: meta.source,
        };
      }),
      available: outcome.value !== null,
      reason: outcome.reason,
      explanation: def.explanation,
      isCustom: true,
    } as RatioResult;
  });
}

/** Validates a definition before it is saved. Returns a normalised copy. */
export function validateDefinition(input: {
  key?: string;
  label: string;
  formula: string;
  unit: RatioUnit;
  explanation?: string;
  group?: CustomRatioDefinition['group'];
}): CustomRatioDefinition {
  const label = input.label.trim();
  if (!label) throw new FormulaError('Give the ratio a name.');

  // Throws FormulaError with a readable message when the formula is unusable.
  compileFormula(input.formula);

  const key =
    input.key?.trim() ||
    `custom_${label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40)}`;

  return {
    key,
    label,
    formula: input.formula.trim(),
    unit: input.unit,
    explanation: input.explanation?.trim() || 'A custom ratio defined by your organisation.',
    group: input.group ?? 'profitability',
  };
}
