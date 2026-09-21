import { Decimal } from 'decimal.js';

import { AppError } from './errors.js';
import { message } from './i18n.js';

type TokenType = 'number' | 'identifier' | '+' | '-' | '*' | '/' | '(' | ')' | '.' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

type FormulaNode =
  | { type: 'number'; value: string }
  | { type: 'path'; parts: string[] }
  | { type: 'unary'; operator: '+' | '-'; operand: FormulaNode }
  | { type: 'binary'; operator: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode };

const MAX_FORMULA_LENGTH = 2_000;
const MAX_TOKENS = 256;
const MAX_AMOUNT = new Decimal('99999999999999.999999');
const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'prototype', 'constructor']);

function invalidFormula(position?: number): AppError {
  return new AppError(
    message('pricing.formulaInvalid'),
    400,
    'INVALID_PRICE_FORMULA',
    position === undefined ? undefined : { position },
  );
}

function tokenize(formula: string): Token[] {
  if (!formula.trim() || formula.length > MAX_FORMULA_LENGTH) throw invalidFormula();
  const tokens: Token[] = [];
  let position = 0;
  while (position < formula.length) {
    const char = formula[position]!;
    if (/\s/.test(char)) {
      position += 1;
      continue;
    }
    if ('+-*/().'.includes(char)) {
      tokens.push({ type: char as TokenType, value: char, position });
      position += 1;
    } else if (/\d/.test(char)) {
      const start = position;
      while (position < formula.length && /\d/.test(formula[position]!)) position += 1;
      if (formula[position] === '.') {
        position += 1;
        const decimalStart = position;
        while (position < formula.length && /\d/.test(formula[position]!)) position += 1;
        if (position === decimalStart) throw invalidFormula(position);
      }
      tokens.push({ type: 'number', value: formula.slice(start, position), position: start });
    } else if (/[A-Za-z_]/.test(char)) {
      const start = position;
      position += 1;
      while (position < formula.length && /[A-Za-z0-9_]/.test(formula[position]!)) position += 1;
      tokens.push({ type: 'identifier', value: formula.slice(start, position), position: start });
    } else {
      throw invalidFormula(position);
    }
    if (tokens.length > MAX_TOKENS) throw invalidFormula(position);
  }
  tokens.push({ type: 'eof', value: '', position });
  return tokens;
}

class FormulaParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): FormulaNode {
    const node = this.additive();
    if (this.current().type !== 'eof') throw invalidFormula(this.current().position);
    return node;
  }

  private additive(): FormulaNode {
    let node = this.multiplicative();
    while (this.current().type === '+' || this.current().type === '-') {
      const operator = this.consume().type as '+' | '-';
      node = { type: 'binary', operator, left: node, right: this.multiplicative() };
    }
    return node;
  }

  private multiplicative(): FormulaNode {
    let node = this.unary();
    while (this.current().type === '*' || this.current().type === '/') {
      const operator = this.consume().type as '*' | '/';
      node = { type: 'binary', operator, left: node, right: this.unary() };
    }
    return node;
  }

  private unary(): FormulaNode {
    if (this.current().type === '+' || this.current().type === '-') {
      const operator = this.consume().type as '+' | '-';
      return { type: 'unary', operator, operand: this.unary() };
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    const token = this.current();
    if (token.type === 'number') {
      this.consume();
      return { type: 'number', value: token.value };
    }
    if (token.type === '(') {
      this.consume();
      const node = this.additive();
      this.expect(')');
      return node;
    }
    if (token.type !== 'identifier' || FORBIDDEN_PROPERTIES.has(token.value)) {
      throw invalidFormula(token.position);
    }
    this.consume();
    const parts: string[] = [token.value];
    while (this.current().type === '.') {
      this.consume();
      const part = this.expect('identifier');
      if (FORBIDDEN_PROPERTIES.has(part.value)) throw invalidFormula(part.position);
      parts.push(part.value);
    }
    if (parts[0] === 'a') throw invalidFormula(token.position);
    return { type: 'path', parts };
  }

  private current(): Token {
    return this.tokens[this.index]!;
  }

  private consume(): Token {
    const token = this.current();
    this.index += 1;
    return token;
  }

  private expect(type: TokenType): Token {
    const token = this.current();
    if (token.type !== type) throw invalidFormula(token.position);
    return this.consume();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError(message('pricing.billingContextInvalid'), 400, 'INVALID_BILLING_CONTEXT');
  }
}

export function parseFormulaBillingContext(value: unknown): Record<string, unknown> {
  let parsed: unknown = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof parsed === 'string') {
      const trimmed = parsed.trim();
      if (!trimmed) {
        throw new AppError(message('pricing.billingContextRequired'), 400, 'BILLING_CONTEXT_REQUIRED');
      }
      parsed = parseJson(trimmed);
      continue;
    }
    if (isRecord(parsed) && Object.hasOwn(parsed, 'BillingContext')) {
      parsed = parsed.BillingContext;
      continue;
    }
    if (isRecord(parsed)) return parsed;
    break;
  }
  throw new AppError(message('pricing.billingContextInvalid'), 400, 'INVALID_BILLING_CONTEXT');
}

function pathValue(context: Record<string, unknown>, parts: string[]): Decimal {
  let value: unknown = context;
  for (const part of parts) {
    if (!isRecord(value) || !Object.hasOwn(value, part)) {
      throw new AppError(
        message('pricing.formulaMissingField', { path: parts.join('.') }),
        400,
        'PRICE_FORMULA_FIELD_MISSING',
      );
    }
    value = value[part];
  }
  if (value === null) return new Decimal(0);
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') {
    throw new AppError(
      message('pricing.formulaNonNumericField', { path: parts.join('.') }),
      400,
      'PRICE_FORMULA_FIELD_NOT_NUMERIC',
    );
  }
  try {
    const result = new Decimal(value);
    if (!result.isFinite()) throw new Error('non-finite');
    return result;
  } catch {
    throw new AppError(
      message('pricing.formulaNonNumericField', { path: parts.join('.') }),
      400,
      'PRICE_FORMULA_FIELD_NOT_NUMERIC',
    );
  }
}

function evaluateNode(node: FormulaNode, context: Record<string, unknown>): Decimal {
  if (node.type === 'number') return new Decimal(node.value);
  if (node.type === 'path') return pathValue(context, node.parts);
  if (node.type === 'unary') {
    const operand = evaluateNode(node.operand, context);
    return node.operator === '-' ? operand.negated() : operand;
  }
  const left = evaluateNode(node.left, context);
  const right = evaluateNode(node.right, context);
  if (node.operator === '+') return left.plus(right);
  if (node.operator === '-') return left.minus(right);
  if (node.operator === '*') return left.mul(right);
  if (right.isZero()) {
    throw new AppError(message('pricing.formulaDivisionByZero'), 400, 'PRICE_FORMULA_DIVISION_BY_ZERO');
  }
  return left.div(right);
}

export function validatePriceFormula(formula: string): string {
  const normalized = formula.trim();
  new FormulaParser(tokenize(normalized)).parse();
  return normalized;
}

export function evaluatePriceFormula(formula: string, billingContext: unknown): Decimal {
  const normalized = formula.trim();
  const node = new FormulaParser(tokenize(normalized)).parse();
  const result = evaluateNode(node, parseFormulaBillingContext(billingContext));
  if (!result.isFinite() || result.isNegative() || result.gt(MAX_AMOUNT)) {
    throw new AppError(message('pricing.formulaResultInvalid'), 400, 'INVALID_PRICE_FORMULA_RESULT');
  }
  return result;
}
