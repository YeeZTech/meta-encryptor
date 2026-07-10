import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Unsealer } from '../src/browser/Unsealer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Helper: feed chunks into an Unsealer via its writable and collect all
 * plaintext output from its readable.
 */
async function collectOutputs(unsealer, chunks) {
  const writer = unsealer.writable.getWriter();
  const reader = unsealer.readable.getReader();
  const outputs = [];

  // write chunks in background then close
  const writePromise = (async () => {
    for (const c of chunks) {
      await writer.write(typeof c === 'string' ? new TextEncoder().encode(c) : c);
    }
    await writer.close();
  })();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    outputs.push(value);
  }
  await writePromise;
  return outputs;
}

describe('Browser Unsealer compatibility', () => {
  it('should decrypt to original content (single chunk input)', async () => {
    const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'browser-unsealer-fixture-small.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const streamBuf = fs.readFileSync(fixture.sealed_path);

    const un = new Unsealer({ privateKeyHex: fixture.private_key_hex });
    const splitAt = Math.min(512, streamBuf.length);
    const chunks = await collectOutputs(un, [
      streamBuf.subarray(0, splitAt),
      streamBuf.subarray(splitAt)
    ]);
    const merged = Buffer.concat(chunks.map(b => Buffer.from(b)));
    const plain = fs.readFileSync(fixture.plain_path);
    expect(merged.equals(Buffer.from(plain))).toBe(true);
  }, 20000);

  it('should decrypt multiple inputs batched', async () => {
    const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'browser-unsealer-fixture-small.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const streamBuf = fs.readFileSync(fixture.sealed_path);

    const un = new Unsealer({ privateKeyHex: fixture.private_key_hex });
    // split into random-sized chunks
    const parts = [];
    let offset = 0;
    const sizes = [13, 7, 1024, 5, 256];
    let idx = 0;
    while (offset < streamBuf.length) {
      const n = Math.min(streamBuf.length - offset, sizes[idx % sizes.length]);
      parts.push(streamBuf.subarray(offset, offset + n));
      offset += n;
      idx++;
    }
    const outputs = await collectOutputs(un, parts);
    const merged = Buffer.concat(outputs.map(b => Buffer.from(b)));
    const plain = fs.readFileSync(fixture.plain_path);
    expect(merged.equals(Buffer.from(plain))).toBe(true);
  }, 20000);
});
