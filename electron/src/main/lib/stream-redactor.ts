import { StringDecoder } from 'node:string_decoder';

const REDACTION = '[REDACTED]';

export interface StreamRedactor {
  write(chunk: Buffer | string): void;
  end(chunk?: Buffer | string): void;
}

function redact(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTION);
  }
  return redacted;
}

export function createStreamRedactor(
  secrets: readonly string[],
  emit: (chunk: string) => void,
): StreamRedactor {
  const activeSecrets = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const tailLength = Math.max(0, ...activeSecrets.map((secret) => secret.length - 1));
  const decoder = new StringDecoder('utf8');
  let tail = '';
  let ended = false;

  function accept(text: string): void {
    const output = redact(`${tail}${text}`, activeSecrets);
    if (tailLength === 0) {
      tail = '';
      if (output) emit(output);
      return;
    }
    const emitLength = Math.max(0, output.length - tailLength);
    if (emitLength > 0) emit(output.slice(0, emitLength));
    tail = output.slice(emitLength);
  }

  return {
    write(chunk) {
      if (ended) throw new Error('cannot write to an ended stream redactor');
      accept(decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    },
    end(chunk) {
      if (ended) return;
      ended = true;
      const finalChunk = chunk === undefined
        ? decoder.end()
        : decoder.end(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const output = redact(`${tail}${finalChunk}`, activeSecrets);
      tail = '';
      if (output) emit(output);
    },
  };
}
