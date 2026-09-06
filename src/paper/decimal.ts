/** Fixed-point TEXT decimal (scale 18). Paper stores money/prices as strings, not IEEE floats. */
const SCALE = 18n;
const TEN = 10n;

function pow10(n: bigint): bigint {
  let out = 1n;
  for (let i = 0n; i < n; i++) out *= TEN;
  return out;
}

const SCALE_FACTOR = pow10(SCALE);

export class Dec {
  readonly raw: bigint;

  private constructor(raw: bigint) {
    this.raw = raw;
  }

  static from(text: string): Dec {
    const value = text.trim();
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      throw new Error(`invalid decimal: ${text}`);
    }
    const neg = value.startsWith("-");
    const unsigned = neg ? value.slice(1) : value;
    const [intPart, fracPart = ""] = unsigned.split(".");
    const frac = fracPart.padEnd(Number(SCALE), "0").slice(0, Number(SCALE));
    const raw = BigInt(intPart) * SCALE_FACTOR + BigInt(frac);
    return new Dec(neg ? -raw : raw);
  }

  static zero(): Dec {
    return new Dec(0n);
  }

  add(other: Dec): Dec {
    return new Dec(this.raw + other.raw);
  }

  sub(other: Dec): Dec {
    return new Dec(this.raw - other.raw);
  }

  mul(other: Dec): Dec {
    return new Dec((this.raw * other.raw) / SCALE_FACTOR);
  }

  div(other: Dec): Dec {
    if (other.raw === 0n) throw new Error("division by zero");
    return new Dec((this.raw * SCALE_FACTOR) / other.raw);
  }

  abs(): Dec {
    return this.raw < 0n ? new Dec(-this.raw) : this;
  }

  neg(): Dec {
    return new Dec(-this.raw);
  }

  cmp(other: Dec): number {
    if (this.raw < other.raw) return -1;
    if (this.raw > other.raw) return 1;
    return 0;
  }

  eq(other: Dec): boolean {
    return this.raw === other.raw;
  }

  lte(other: Dec): boolean {
    return this.raw <= other.raw;
  }

  gte(other: Dec): boolean {
    return this.raw >= other.raw;
  }

  lt(other: Dec): boolean {
    return this.raw < other.raw;
  }

  gt(other: Dec): boolean {
    return this.raw > other.raw;
  }

  isZero(): boolean {
    return this.raw === 0n;
  }

  isNeg(): boolean {
    return this.raw < 0n;
  }

  isPos(): boolean {
    return this.raw > 0n;
  }

  /** True when `this <= other * (1 + relTol)` (relative slack for TEXT rounding). */
  lteRel(other: Dec, relTol: Dec): boolean {
    if (this.lte(other)) return true;
    const slack = other.abs().mul(relTol);
    return this.sub(other).lte(slack);
  }

  toText(): string {
    const neg = this.raw < 0n;
    const abs = neg ? -this.raw : this.raw;
    const digits = abs.toString().padStart(Number(SCALE) + 1, "0");
    const intPart = digits.slice(0, -Number(SCALE));
    const frac = digits.slice(-Number(SCALE)).replace(/0+$/, "");
    const body = frac ? `${intPart}.${frac}` : intPart;
    return neg ? `-${body}` : body;
  }
}

/** 1e-8 relative tolerance from the paper spec (math epsilon, not a risk policy). */
export const REL_TOL = Dec.from("0.00000001");
