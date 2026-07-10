import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { Sealer } from '../src/node/Sealer.js';
import { Unsealer } from '../src/node/Unsealer.js';
import { SealedFileStream } from '../src/node/SealedFileStream.js';
import { RecoverableReadStream, RecoverableWriteStream } from '../src/node/Recoverable.js';
import { PipelineContextInFile } from '../src/node/PipelineConext.js';
import { HeaderSize } from '../src/common/limits.js';
import { key_pair, testPath } from './helper.js';

function seal(input) {
  return new Promise((resolve, reject) => {
    const out = [];
    const sealer = new Sealer({ keyPair: key_pair });
    sealer.on('data', (chunk) => out.push(chunk));
    sealer.on('end', () => resolve(Buffer.concat(out)));
    sealer.on('error', reject);
    sealer.end(input);
  });
}

function waitForError(stream) {
  return new Promise((resolve, reject) => {
    stream.once('error', resolve);
    stream.once('end', () => reject(new Error('expected stream error')));
    stream.resume();
  });
}

function waitForFinish(stream) {
  return new Promise((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
  });
}

function stagingPath(target, token = 'a'.repeat(24)) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.meta-encryptor.${token}.staging`
  );
}

async function runSameFilePipeline(target, context) {
  const reader = new RecoverableReadStream(target, context, { highWaterMark: 4096 });
  const unsealer = new Unsealer({ keyPair: key_pair, context });
  const writer = new RecoverableWriteStream(target, context);
  const completion = waitForFinish(writer);
  for (const stream of [reader, unsealer]) {
    stream.once('error', (error) => writer.destroy(error));
  }
  reader.pipe(unsealer).pipe(writer);
  await completion;
}

describe('recoverable hardening', () => {
  test('generic writes advance by bytes actually written and are not truncated to zero', async () => {
    const target = testPath('recoverable-generic.out');
    const checkpoint = testPath('recoverable-generic.ctx');
    const context = new PipelineContextInFile(checkpoint);
    await context.loadContext();
    const writer = new RecoverableWriteStream(target, context);

    writer.end(Buffer.from('generic output'));
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    expect(fs.readFileSync(target).toString()).toBe('generic output');
    expect(context.context.writeStart).toBe(Buffer.byteLength('generic output'));
  });

  test('missing resumed output is rejected instead of silently recreating it', async () => {
    const target = testPath('missing-resume.out');
    const context = {
      context: { checkpointVersion: 2, writeStart: 5 },
      runtime: { rawCommitted: 7, plainCommitted: 5, pendingBlocks: [] },
      saveContext: () => Promise.resolve()
    };
    expect(() => new RecoverableWriteStream(target, context)).toThrow(
      expect.objectContaining({ code: 'ERR_OUTPUT_MISMATCH' })
    );
  });

  test('same-file partial output is staged and leaves ciphertext unchanged', async () => {
    const source = testPath('same-file-pause.sealed');
    const original = Buffer.from('ciphertext source must survive pause');
    fs.writeFileSync(source, original);
    const context = {
      context: {
        checkpointVersion: 2,
        status: 'file',
        readStart: 0,
        writeStart: 0,
        readItemCount: 0,
        phase: 'processing'
      },
      runtime: {
        sourcePath: source,
        rawCommitted: 0,
        plainCommitted: 0,
        pendingBlocks: [{ rawSize: 20, plainSize: 5, remainingPlain: 5 }],
        unattributedPlain: 0,
        inputComplete: false
      },
      saveContext: () => Promise.resolve()
    };
    const writer = new RecoverableWriteStream(source, context);
    writer.end(Buffer.from('plain'));
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    expect(fs.readFileSync(source)).toEqual(original);
    expect(context.context.output.policy).toBe('same-file-staging');
    expect(path.dirname(context.context.output.stagingPath)).toBe(path.dirname(path.resolve(source)));
    expect(path.basename(context.context.output.stagingPath)).toMatch(
      new RegExp(`^\\.${path.basename(source)}\\.meta-encryptor\\.[0-9a-f]{24}\\.staging$`, 'i')
    );
    const stagingStat = fs.lstatSync(context.context.output.stagingPath);
    expect(stagingStat.isFile()).toBe(true);
    expect(stagingStat.isSymbolicLink()).toBe(false);
    expect(stagingStat.nlink).toBe(1);
    expect(fs.readFileSync(context.context.output.stagingPath)).toEqual(Buffer.from('plain'));
    fs.unlinkSync(context.context.output.stagingPath);
  });

  test('zero-length historical item commits without a plaintext write callback', async () => {
    const source = testPath('zero-item-source.sealed');
    const target = testPath('zero-item-output.bin');
    const context = {
      context: {
        checkpointVersion: 2,
        status: 'file',
        readStart: 0,
        writeStart: 0,
        readItemCount: 0,
        phase: 'verified'
      },
      runtime: {
        sourcePath: source,
        rawCommitted: 0,
        plainCommitted: 0,
        pendingBlocks: [{ rawSize: 137, plainSize: 0, remainingPlain: 0 }],
        unattributedPlain: 0,
        inputComplete: true
      },
      saveContext: () => Promise.resolve()
    };

    const writer = new RecoverableWriteStream(target, context);
    const completion = waitForFinish(writer);
    writer.end();
    await completion;

    expect(fs.readFileSync(target)).toHaveLength(0);
    expect(context.context).toMatchObject({
      readStart: 137,
      writeStart: 0,
      readItemCount: 1,
      phase: 'complete'
    });
    expect(context.runtime.pendingBlocks).toHaveLength(0);
  });

  test('checkpoint cannot redirect a staging truncate outside its private namespace', () => {
    const target = testPath('staging-path-target.sealed');
    const victim = testPath('staging-path-victim.txt');
    const victimBytes = Buffer.from('must not be truncated');
    fs.writeFileSync(target, Buffer.from('sealed source'));
    fs.writeFileSync(victim, victimBytes);
    const context = {
      context: {
        checkpointVersion: 2,
        status: 'file',
        writeStart: 0,
        phase: 'processing',
        output: {
          requestedPath: target,
          policy: 'same-file-staging',
          stagingPath: victim
        }
      },
      runtime: { sourcePath: target },
      saveContext: () => Promise.resolve()
    };

    expect(() => new RecoverableWriteStream(target, context)).toThrow(
      expect.objectContaining({ code: 'ERR_CHECKPOINT_INVALID' })
    );
    expect(fs.readFileSync(victim)).toEqual(victimBytes);
  });

  test('staging aliases are rejected before truncation', () => {
    const target = testPath('staging-alias-target.sealed');
    const victim = testPath('staging-alias-victim.txt');
    const alias = stagingPath(target, 'b'.repeat(24));
    const victimBytes = Buffer.from('linked victim must survive');
    fs.writeFileSync(target, Buffer.from('sealed source'));
    fs.writeFileSync(victim, victimBytes);
    try { fs.unlinkSync(alias); } catch (_) {}
    try {
      fs.symlinkSync(victim, alias, 'file');
    } catch (_) {
      fs.linkSync(victim, alias);
    }

    const context = {
      context: {
        checkpointVersion: 2,
        status: 'file',
        writeStart: 0,
        phase: 'processing',
        output: {
          requestedPath: target,
          policy: 'same-file-staging',
          stagingPath: alias
        }
      },
      runtime: { sourcePath: target },
      saveContext: () => Promise.resolve()
    };

    try {
      expect(() => new RecoverableWriteStream(target, context)).toThrow(
        expect.objectContaining({ code: 'ERR_CHECKPOINT_INVALID' })
      );
      expect(fs.readFileSync(victim)).toEqual(victimBytes);
    } finally {
      try { fs.unlinkSync(alias); } catch (_) {}
    }
  });

  test('same-file full pipeline atomically replaces sealed source after verification', async () => {
    const target = testPath('same-file-complete.sealed');
    const checkpoint = testPath('same-file-complete.ctx');
    const plain = Buffer.from('atomic plaintext '.repeat(12000));
    fs.writeFileSync(target, await seal(plain));

    const context = new PipelineContextInFile(checkpoint);
    await context.loadContext();
    const reader = new RecoverableReadStream(target, context, { highWaterMark: 4096 });
    const unsealer = new Unsealer({ keyPair: key_pair, context });
    const writer = new RecoverableWriteStream(target, context);
    reader.pipe(unsealer).pipe(writer);
    await new Promise((resolve, reject) => {
      for (const stream of [reader, unsealer, writer]) stream.on('error', reject);
      writer.on('finish', resolve);
    });

    expect(fs.readFileSync(target)).toEqual(plain);
    expect(context.context.phase).toBe('complete');
    expect(fs.existsSync(context.context.output.stagingPath)).toBe(false);
  }, 20000);

  test.each([
    ['before rename', true],
    ['after rename', false],
  ])('phase=replacing resumes %s and phase=complete re-entry is idempotent', async (_, hasStaging) => {
    const target = testPath(`replace-${hasStaging ? 'before' : 'after'}.sealed`);
    const checkpoint = testPath(`replace-${hasStaging ? 'before' : 'after'}.ctx`);
    const stage = stagingPath(target, hasStaging ? 'c'.repeat(24) : 'd'.repeat(24));
    const plain = Buffer.from(`verified plaintext ${hasStaging ? 'before' : 'after'} rename`);
    const completedHash = crypto.createHash('sha256').update(plain).digest('hex');

    fs.writeFileSync(target, hasStaging ? Buffer.from('still sealed') : plain);
    if (hasStaging) fs.writeFileSync(stage, plain, { mode: 0o600 });

    const initial = new PipelineContextInFile(checkpoint);
    initial.context = {
      checkpointVersion: 2,
      status: 'file',
      readStart: 211,
      itemBoundary: 211,
      writeStart: plain.length,
      readItemCount: 1,
      data: Buffer.alloc(0),
      phase: 'replacing',
      output: {
        requestedPath: path.resolve(target),
        policy: 'same-file-staging',
        stagingPath: stage,
        // A pre-fix checkpoint could be persisted as "replacing" before
        // completedSize/completedHash were recorded.  Cover that migration on
        // the post-rename side of the crash window.
        ...(hasStaging ? { completedSize: plain.length, completedHash } : {})
      }
    };
    await initial.saveContext();

    const resumed = new PipelineContextInFile(checkpoint);
    await resumed.loadContext();
    await runSameFilePipeline(target, resumed);
    expect(fs.readFileSync(target)).toEqual(plain);
    expect(fs.existsSync(stage)).toBe(false);
    expect(resumed.context.phase).toBe('complete');

    // Rebuild the documented pipeline from the completed checkpoint.  The
    // reader must EOF without handing plaintext to SealedFileStream.
    const completed = new PipelineContextInFile(checkpoint);
    await completed.loadContext();
    await runSameFilePipeline(target, completed);
    expect(fs.readFileSync(target)).toEqual(plain);
    expect(completed.context.phase).toBe('complete');
  }, 20000);

  test('checkpoint source fingerprint rejects a replaced sealed source', async () => {
    const target = testPath('source-change.sealed');
    const checkpoint = testPath('source-change.ctx');
    fs.writeFileSync(target, await seal(Buffer.from('fingerprint me')));
    const context = new PipelineContextInFile(checkpoint);
    await context.loadContext();

    const first = new RecoverableReadStream(target, context);
    await new Promise((resolve, reject) => {
      first.once('data', () => first.destroy());
      first.once('close', resolve);
      first.once('error', reject);
    });
    expect(context.context.source.headerFingerprint).toHaveLength(64);

    const bytes = fs.readFileSync(target);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(target, bytes);
    const resumed = new RecoverableReadStream(target, context);
    await expect(waitForError(resumed)).resolves.toMatchObject({ code: 'ERR_SOURCE_CHANGED' });
  });

  test('empty sealed file streams header-only and unseals successfully', async () => {
    const target = testPath('empty.sealed');
    const sealed = await seal(Buffer.alloc(0));
    expect(sealed).toHaveLength(HeaderSize);
    fs.writeFileSync(target, sealed);

    const input = new SealedFileStream(target);
    const unsealer = new Unsealer({ keyPair: key_pair });
    const output = [];
    input.pipe(unsealer);
    unsealer.on('data', (chunk) => output.push(chunk));
    await new Promise((resolve, reject) => {
      input.on('error', reject);
      unsealer.on('error', reject);
      unsealer.on('end', resolve);
    });
    expect(Buffer.concat(output)).toHaveLength(0);
  });

  test('truncated context load resets both persisted and runtime state', async () => {
    const checkpoint = testPath('truncated.ctx');
    fs.writeFileSync(checkpoint, Buffer.from([0, 0, 0, 20, 1, 2]));
    const context = new PipelineContextInFile(checkpoint);
    context.context = { stale: true };
    context.runtime.rawCommitted = 99;
    await expect(context.loadContext()).rejects.toMatchObject({ code: 'ERR_CHECKPOINT_INVALID' });
    expect(context.context).toEqual({});
    expect(context.runtime).toMatchObject({
      rawCommitted: 0,
      plainCommitted: 0,
      pendingBlocks: [],
      unattributedPlain: 0,
      inputComplete: false
    });
  });
});
