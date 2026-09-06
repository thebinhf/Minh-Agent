export class PaperReject extends Error {
  readonly error: string;
  readonly gate: string;
  readonly extra: Record<string, unknown>;

  constructor(error: string, gate: string, extra: Record<string, unknown> = {}) {
    super(error);
    this.name = "PaperReject";
    this.error = error;
    this.gate = gate;
    this.extra = extra;
  }

  toJSON(): Record<string, unknown> {
    return { mode: "paper", error: this.error, gate: this.gate, ...this.extra };
  }
}

export class PaperUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperUsageError";
  }
}

export class PaperSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperSafetyError";
  }
}
