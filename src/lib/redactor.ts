const SECRET_KEY =
  /^(?:authorization|proxy-authorization|credentials?|password|secret|token|api[-_]?key)$|(?:^|[-_])(?:password|secret|token|api[-_]?key)$|(?:bearer|access|refresh|auth|api)Token$|apiKey$/i;

export class Redactor {
  readonly #secrets = new Set<string>();

  add(value: string | undefined): void {
    if (value && value.length >= 4) this.#secrets.add(value);
  }

  addHeaders(headers: Record<string, string>): void {
    for (const [name, value] of Object.entries(headers)) {
      if (SECRET_KEY.test(name)) {
        this.add(value);
        const bearer = /^Bearer\s+(.+)$/i.exec(value);
        if (bearer?.[1]) this.add(bearer[1]);
      }
    }
  }

  text(value: string): string {
    let result = value;
    for (const secret of this.#secrets) {
      result = result.split(secret).join("[REDACTED]");
    }
    return result
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;}]+/gi, "$1[REDACTED]")
      .replace(/([?&](?:token|api_key|key|secret)=)[^&#\s]+/gi, "$1[REDACTED]");
  }

  value(input: unknown, key = ""): unknown {
    if (SECRET_KEY.test(key)) return "[REDACTED]";
    if (typeof input === "string") return this.text(input);
    if (Array.isArray(input)) return input.map((item) => this.value(item));
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([childKey, value]) => [
          childKey,
          this.value(value, childKey),
        ]),
      );
    }
    return input;
  }
}

export function collectHeaderSecrets(
  serverHeaders: ReadonlyArray<Record<string, string>>,
): Redactor {
  const redactor = new Redactor();
  for (const headers of serverHeaders) redactor.addHeaders(headers);
  return redactor;
}
