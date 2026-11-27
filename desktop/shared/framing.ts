/** Node-only strict bounded JSON framing shared by owned transports. */
import { MAX_FRAME_BYTES } from "./contracts";
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (!body.length || body.length > MAX_FRAME_BYTES)
    throw new TypeError("Invalid frame");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
function decode(body: Buffer): Record<string, unknown> {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(body);
  const value: unknown = JSON.parse(text);
  // JSON.parse alone accepts duplicate keys. Scan already-valid JSON tokens, retaining
  // one key set per object, so escaped duplicate names fail just like Python's pairs hook.
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const token of text.matchAll(
    /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/gu,
  )) {
    const word = token[0];
    const top = stack.at(-1);
    if (word === "{") stack.push({ keys: new Set(), key: true });
    else if (word === "[") stack.push(null);
    else if (word === "}" || word === "]") stack.pop();
    else if (word === "," && top) top.key = true;
    else if (word.startsWith('"') && top?.key) {
      const key = JSON.parse(word) as string;
      if (top.keys.has(key)) throw new TypeError("Invalid frame");
      top.keys.add(key);
      top.key = false;
    }
  }
  function walk(item: unknown, depth: number): void {
    if (depth > 32) throw new TypeError("Invalid frame");
    if (typeof item === "string" && /[\uD800-\uDFFF]/u.test(item))
      throw new TypeError("Invalid frame");
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (/[\uD800-\uDFFF]/u.test(key)) throw new TypeError("Invalid frame");
        walk(child, depth + 1);
      }
    }
  }
  walk(value, 0);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid frame");
  return value as Record<string, unknown>;
}
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  get incomplete(): boolean {
    return this.buffer.length > 0;
  }
  push(
    chunk: Buffer,
    maxMessages = Number.MAX_SAFE_INTEGER,
  ): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      let target = 4;
      if (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32BE(0);
        if (!size || size > MAX_FRAME_BYTES)
          throw new TypeError("Invalid frame");
        target = size + 4;
      }
      const take = Math.min(target - this.buffer.length, chunk.length - offset);
      this.buffer = Buffer.concat([
        this.buffer,
        chunk.subarray(offset, offset + take),
      ]);
      offset += take;
      if (this.buffer.length < 4) continue;
      const size = this.buffer.readUInt32BE(0);
      if (!size || size > MAX_FRAME_BYTES) throw new TypeError("Invalid frame");
      if (this.buffer.length < size + 4) continue;
      if (messages.length >= maxMessages)
        throw new TypeError("Invalid frame batch");
      messages.push(decode(this.buffer.subarray(4)));
      this.buffer = Buffer.alloc(0);
    }
    return messages;
  }
}
