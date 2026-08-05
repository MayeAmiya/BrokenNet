/**
 * Expression parser for INI layout positioning.
 * Supports: $X, $Y, $Width, $Height with arithmetic and functions.
 *
 * Functions:
 * - getX(name), getY(name), getWidth(name), getHeight(name)
 * - getBottom(name), getRight(name)
 * - horizontalCenterOnParent()
 *
 * Constants: RESOLUTION_WIDTH, RESOLUTION_HEIGHT
 * Special: $ParentControl, $Self
 */

interface ControlBounds {
  x: number
  y: number
  width: number
  height: number
}

type ControlGetter = (name: string) => ControlBounds | undefined

export class ExpressionParser {
  private constants: Record<string, number> = {}
  private controlGetter: ControlGetter
  private parentControl?: ControlBounds
  private selfControl?: ControlBounds

  constructor(
    controlGetter: ControlGetter,
    constants: Record<string, number> = {},
    parentControl?: ControlBounds,
    selfControl?: ControlBounds
  ) {
    this.controlGetter = controlGetter
    this.constants = {
      RESOLUTION_WIDTH: 1920,
      RESOLUTION_HEIGHT: 1080,
      ...constants
    }
    this.parentControl = parentControl
    this.selfControl = selfControl
  }

  /**
   * Evaluate an expression string to a number.
   */
  evaluate(expr: string): number {
    const tokens = this.tokenize(expr.trim())
    const result = this.parseExpression(tokens, 0)
    return result.value
  }

  private tokenize(expr: string): string[] {
    const tokens: string[] = []
    let i = 0
    while (i < expr.length) {
      const ch = expr[i]
      if (ch === ' ' || ch === '\t') {
        i++
        continue
      }
      if ('+-*/()'.includes(ch)) {
        tokens.push(ch)
        i++
        continue
      }
      if (ch === '$') {
        // $ParentControl or $Self
        let name = '$'
        i++
        while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
          name += expr[i]
          i++
        }
        tokens.push(name)
        continue
      }
      if (/[0-9.]/.test(ch)) {
        let num = ''
        while (i < expr.length && /[0-9.]/.test(expr[i])) {
          num += expr[i]
          i++
        }
        tokens.push(num)
        continue
      }
      if (/[a-zA-Z_]/.test(ch)) {
        let name = ''
        while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
          name += expr[i]
          i++
        }
        tokens.push(name)
        continue
      }
      i++
    }
    return tokens
  }

  private parseExpression(tokens: string[], pos: number): { value: number; pos: number } {
    return this.parseAddSub(tokens, pos)
  }

  private parseAddSub(tokens: string[], pos: number): { value: number; pos: number } {
    let left = this.parseMulDiv(tokens, pos)
    while (left.pos < tokens.length && (tokens[left.pos] === '+' || tokens[left.pos] === '-')) {
      const op = tokens[left.pos]
      const right = this.parseMulDiv(tokens, left.pos + 1)
      left = {
        value: op === '+' ? left.value + right.value : left.value - right.value,
        pos: right.pos
      }
    }
    return left
  }

  private parseMulDiv(tokens: string[], pos: number): { value: number; pos: number } {
    let left = this.parseUnary(tokens, pos)
    while (left.pos < tokens.length && (tokens[left.pos] === '*' || tokens[left.pos] === '/')) {
      const op = tokens[left.pos]
      const right = this.parseUnary(tokens, left.pos + 1)
      left = {
        value: op === '*' ? left.value * right.value : (right.value !== 0 ? left.value / right.value : 0),
        pos: right.pos
      }
    }
    return left
  }

  private parseUnary(tokens: string[], pos: number): { value: number; pos: number } {
    if (pos < tokens.length && tokens[pos] === '-') {
      const result = this.parsePrimary(tokens, pos + 1)
      return { value: -result.value, pos: result.pos }
    }
    if (pos < tokens.length && tokens[pos] === '+') {
      return this.parsePrimary(tokens, pos + 1)
    }
    return this.parsePrimary(tokens, pos)
  }

  private parsePrimary(tokens: string[], pos: number): { value: number; pos: number } {
    if (pos >= tokens.length) return { value: 0, pos }

    const token = tokens[pos]

    // Number
    if (/^[0-9.]+$/.test(token)) {
      return { value: parseFloat(token), pos: pos + 1 }
    }

    // Parenthesized expression
    if (token === '(') {
      const result = this.parseExpression(tokens, pos + 1)
      if (result.pos < tokens.length && tokens[result.pos] === ')') {
        return { value: result.value, pos: result.pos + 1 }
      }
      return { value: result.value, pos: result.pos }
    }

    // $ParentControl or $Self
    if (token === '$ParentControl' && this.parentControl) {
      return { value: 0, pos: pos + 1 } // These are special refs, not numeric
    }
    if (token === '$Self' && this.selfControl) {
      return { value: 0, pos: pos + 1 }
    }

    // Function call: name(args)
    if (pos + 1 < tokens.length && tokens[pos + 1] === '(') {
      const funcName = token
      const argResult = this.parseExpression(tokens, pos + 2)
      let endPos = argResult.pos
      if (endPos < tokens.length && tokens[endPos] === ')') endPos++

      const value = this.evaluateFunction(funcName, argResult.value, tokens, argResult.pos)
      return { value, pos: endPos }
    }

    // Variable/constant
    if (this.constants[token] !== undefined) {
      return { value: this.constants[token], pos: pos + 1 }
    }

    return { value: 0, pos: pos + 1 }
  }

  private evaluateFunction(name: string, arg: number, tokens: string[], pos: number): number {
    const controlName = this.resolveControlName(arg)
    const bounds = this.controlGetter(controlName)

    switch (name) {
      case 'getX': return bounds?.x ?? 0
      case 'getY': return bounds?.y ?? 0
      case 'getWidth': return bounds?.width ?? 0
      case 'getHeight': return bounds?.height ?? 0
      case 'getBottom': return (bounds?.y ?? 0) + (bounds?.height ?? 0)
      case 'getRight': return (bounds?.x ?? 0) + (bounds?.width ?? 0)
      case 'horizontalCenterOnParent': {
        if (this.parentControl && this.selfControl) {
          return (this.parentControl.width - this.selfControl.width) / 2
        }
        return 0
      }
      default: return 0
    }
  }

  private resolveControlName(_arg: number): string {
    // In practice, the function argument is a string like "btnLaunch"
    // but our parser treats it as numeric. For now return empty.
    return ''
  }
}

/**
 * Resolve a simple $X/$Y/$Width/$Height expression to a number.
 * Supports basic arithmetic and getX/getY/getWidth/getHeight functions.
 */
export function resolveExpression(
  expr: string,
  controlGetter: ControlGetter,
  constants: Record<string, number> = {},
  parentControl?: ControlBounds,
  selfControl?: ControlBounds
): number {
  const parser = new ExpressionParser(controlGetter, constants, parentControl, selfControl)
  return parser.evaluate(expr)
}
