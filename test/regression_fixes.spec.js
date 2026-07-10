/**
 * Regression tests for the download-hang fixes:
 *  - truncated sealed input must ERROR, not hang or silently truncate output
 *  - a failed decrypt (wrong key) must ERROR, not silently skip the item
 *  - empty plaintext must still complete
 *  - RecoverableWriteStream._final must not hang when the inner stream is
 *    already finished/destroyed
 *  - readItemCount is persisted into the recoverable context on commit
 *  - createInactivityWatchdog fires once on stall and never after stop()
 */
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { Sealer } from '../src/node/Sealer.js';
import { Unsealer } from '../src/node/Unsealer.js';
import { SealedFileStream } from '../src/node/SealedFileStream.js';
import { RecoverableReadStream, RecoverableWriteStream } from '../src/node/Recoverable.js';
import { PipelineContextInFile } from '../src/node/PipelineConext.js';
import { HeaderSize, BlockInfoSize } from '../src/common/limits.js';
import { validateHeader } from '../src/common/unsealer_core.js';
import { createInactivityWatchdog } from '../src/common/watchdog.js';
import { key_pair, testPath } from './helper';

const other_key_pair = {
  private_key:
    '2b3e4b3f6cba1a54a219c521c825f1a30045d9c62571a83b56c8e6b56b3e0a12',
};

function sealBuffer(input, chunkSize) {
  return new Promise((resolve, reject) => {
    const sealer = new Sealer({ keyPair: key_pair });
    const chunks = [];
    sealer.on('data', (c) => chunks.push(c));
    sealer.on('end', () => resolve(Buffer.concat(chunks)));
    sealer.on('error', reject);
    if (chunkSize) {
      for (let offset = 0; offset < input.length; offset += chunkSize) {
        sealer.write(input.subarray(offset, offset + chunkSize));
      }
      sealer.end();
    } else {
      sealer.end(input);
    }
  });
}

/**
 * Reorder a raw sealed buffer ([items][blockInfos][header]) into the layout
 * the Unsealer consumes ([header][items]) — what SealedFileStream does.
 */
function unsealerInput(sealed) {
  const header = sealed.subarray(sealed.length - HeaderSize);
  const { blockNumber } = validateHeader(header);
  const contentSize = sealed.length - HeaderSize - BlockInfoSize * blockNumber;
  return { header, content: sealed.subarray(0, contentSize), contentSize };
}

function firstSealedItemSize(content) {
  return 8 + Number(content.readBigUInt64LE(0));
}

function collectUnsealed(feed, unsealerOpts = {}) {
  return new Promise((resolve, reject) => {
    const unsealer = new Unsealer({ keyPair: key_pair, ...unsealerOpts });
    const out = [];
    const src = new PassThrough();
    src.pipe(unsealer);
    unsealer.on('data', (c) => out.push(c));
    unsealer.on('end', () => resolve(Buffer.concat(out)));
    unsealer.on('error', reject);
    feed(src);
  });
}

describe('unsealer stream termination fixes', () => {
  test('roundtrip completes with exact bytes and emits end', async () => {
    const plain = Buffer.from('hello dianshu download fix'.repeat(1000));
    const sealed = await sealBuffer(plain);
    const { header, content } = unsealerInput(sealed);

    const result = await collectUnsealed((src) => {
      src.write(header);
      src.write(content);
      src.end();
    });
    expect(Buffer.compare(result, plain)).toBe(0);
  });

  test('empty plaintext roundtrip still completes', async () => {
    const sealed = await sealBuffer(Buffer.alloc(0));
    const { header, content } = unsealerInput(sealed);

    const result = await collectUnsealed((src) => {
      src.write(header);
      if (content.length > 0) src.write(content);
      src.end();
    });
    expect(result.length).toBe(0);
  });

  test('truncated input errors with ERR_TRUNCATED_INPUT instead of hanging', async () => {
    const plain = Buffer.from('x'.repeat(200 * 1024)); // several 64KB items
    const sealed = await sealBuffer(plain);
    const { header, content } = unsealerInput(sealed);

    await expect(
      collectUnsealed((src) => {
        src.write(header);
        // cut the last item short
        src.write(content.subarray(0, content.length - 16));
        src.end();
      })
    ).rejects.toMatchObject({ code: 'ERR_TRUNCATED_INPUT' });
  }, 10000);

  test('header-only input (no items) errors instead of hanging', async () => {
    const plain = Buffer.from('y'.repeat(1024));
    const sealed = await sealBuffer(plain);
    const { header } = unsealerInput(sealed);

    await expect(
      collectUnsealed((src) => {
        src.write(header);
        src.end();
      })
    ).rejects.toMatchObject({ code: 'ERR_TRUNCATED_INPUT' });
  }, 10000);

  test('modern resumed checkpoint still rejects truncated remaining input', async () => {
    const sealed = await sealBuffer(Buffer.from('r'.repeat(200 * 1024)), 64 * 1024);
    const { header, content } = unsealerInput(sealed);
    const committedBytes = firstSealedItemSize(content);
    const context = {
      context: {
        readStart: committedBytes,
        writeStart: 64 * 1024,
        readItemCount: 1,
        readItemCountReliable: true,
      },
      runtime: { rawCommitted: committedBytes, plainCommitted: 64 * 1024, pendingBlocks: [] },
    };

    await expect(
      collectUnsealed((src) => {
        src.write(header);
        src.write(content.subarray(committedBytes, content.length - 16));
        src.end();
      }, { context })
    ).rejects.toMatchObject({ code: 'ERR_TRUNCATED_INPUT' });
    expect(context.context.readItemCountReliable).toBe(true);
  }, 10000);

  test('legacy resumed state is never accepted through a lenient EOF path', async () => {
    const sealed = await sealBuffer(Buffer.from('l'.repeat(200 * 1024)), 64 * 1024);
    const { header, content } = unsealerInput(sealed);
    const committedBytes = firstSealedItemSize(content);
    const context = {
      context: { readStart: committedBytes, writeStart: 64 * 1024 },
      runtime: { rawCommitted: committedBytes, plainCommitted: 64 * 1024, pendingBlocks: [] },
    };

    await expect(
      collectUnsealed((src) => {
        src.write(header);
        src.write(content.subarray(committedBytes));
        src.end();
      }, { context })
    ).rejects.toMatchObject({ code: 'ERR_TRUNCATED_INPUT' });
  }, 10000);

  test('wrong key errors instead of silently skipping items', async () => {
    const plain = Buffer.from('z'.repeat(4096));
    const sealed = await sealBuffer(plain);
    const { header, content } = unsealerInput(sealed);

    await expect(
      collectUnsealed(
        (src) => {
          src.write(header);
          src.write(content);
          src.end();
        },
        { keyPair: { ...key_pair, private_key: other_key_pair.private_key } }
      )
    ).rejects.toBeTruthy();
  }, 10000);

  test('trailing block-info/header bytes are rejected when raw file is piped in full', async () => {
    const plain = Buffer.from('t'.repeat(4096));
    const sealed = await sealBuffer(plain);
    const { header } = unsealerInput(sealed);

    // header first, then the WHOLE raw file body incl. blockinfo bytes
    await expect(collectUnsealed((src) => {
      src.write(header);
      src.write(sealed);
      src.end();
    })).rejects.toMatchObject({ code: 'ERR_INVALID_FORMAT' });
  });
});

describe('RecoverableWriteStream finalize fixes', () => {
  test('_final completes even when the inner stream already finished', async () => {
    const target = testPath('rws_inner_finished.out');
    try { fs.unlinkSync(target); } catch (e) {}

    const saveContext = jest.fn(() => Promise.resolve());
    const context = {
      context: { status: 'file', readStart: 0, writeStart: 0, data: Buffer.from('stale') },
      runtime: { rawCommitted: 11, plainCommitted: 3, pendingBlocks: [] },
      saveContext,
    };
    const ws = new RecoverableWriteStream(target, context);

    await new Promise((resolve, reject) => {
      ws.write(Buffer.from('abc'), (err) => (err ? reject(err) : resolve()));
    });

    // simulate a cleanup path ending the inner stream first
    await new Promise((resolve, reject) => {
      ws.writeStream.once('close', resolve);
      ws.writeStream.once('error', reject);
      ws.writeStream.end();
    });
    fs.appendFileSync(target, Buffer.from('garbage tail'));

    await expect(
      new Promise((resolve, reject) => {
        const guard = setTimeout(
          () => reject(new Error('RecoverableWriteStream finish never fired')),
          5000
        );
        ws.on('finish', () => { clearTimeout(guard); resolve(); });
        ws.on('error', (e) => { clearTimeout(guard); reject(e); });
        ws.end();
      })
    ).resolves.toBeUndefined();

    expect(fs.readFileSync(target).toString()).toBe('abc');
    expect(context.context).toMatchObject({ readStart: 11, writeStart: 3 });
    expect(context.context.data).toEqual(Buffer.alloc(0));
    expect(saveContext).toHaveBeenCalledTimes(1);

    try { fs.unlinkSync(target); } catch (e) {}
  }, 10000);

  test('_final surfaces an error when the inner stream was destroyed', async () => {
    const target = testPath('rws_inner_destroyed.out');
    try { fs.unlinkSync(target); } catch (e) {}

    const context = { context: {}, runtime: null, saveContext: () => {} };
    const ws = new RecoverableWriteStream(target, context);
    ws.writeStream.destroy();
    // give the inner stream a tick to settle
    await new Promise((r) => setTimeout(r, 20));

    await expect(
      new Promise((resolve, reject) => {
        const guard = setTimeout(
          () => reject(new Error('RecoverableWriteStream never settled')),
          5000
        );
        ws.on('finish', () => { clearTimeout(guard); resolve('finish'); });
        ws.on('error', (e) => { clearTimeout(guard); reject(e); });
        ws.end();
      })
    ).rejects.toBeTruthy();

    try { fs.unlinkSync(target); } catch (e) {}
  }, 10000);

  test('_final propagates an inner stream error exactly once', async () => {
    const target = testPath('rws_inner_error.out');
    try { fs.unlinkSync(target); } catch (e) {}

    const context = { context: {}, runtime: null, saveContext: () => {} };
    const ws = new RecoverableWriteStream(target, context);
    const errors = [];

    // Keep _final waiting and inject the inner error through its normal event.
    ws.writeStream.end = () => {
      queueMicrotask(() => ws.writeStream.emit('error', new Error('injected inner error')));
    };

    await new Promise((resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error('RecoverableWriteStream inner error never settled')),
        5000
      );
      ws.on('error', (err) => errors.push(err));
      ws.on('close', () => {
        clearTimeout(guard);
        resolve();
      });
      ws.end();
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('injected inner error');

    try { fs.unlinkSync(target); } catch (e) {}
  }, 10000);
});

describe('recoverable pipeline persists readItemCount', () => {
  test('full run commits readItemCount to the context', async () => {
    const srcData = Buffer.from('m'.repeat(150 * 1024)); // multiple items
    const srcFile = testPath('ric_src.bin');
    const sealedFile = testPath('ric_src.bin.sealed');
    const outFile = testPath('ric_src.bin.out');
    const ctxFile = testPath('ric_context');
    for (const f of [srcFile, sealedFile, outFile, ctxFile]) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
    fs.writeFileSync(srcFile, srcData);

    const sealed = await sealBuffer(srcData);
    fs.writeFileSync(sealedFile, sealed);
    const { header } = unsealerInput(sealed);
    const totalItems = validateHeader(header).itemNumber;

    const context = new PipelineContextInFile(ctxFile);
    await context.loadContext();

    const rs = new RecoverableReadStream(sealedFile, context);
    const ws = new RecoverableWriteStream(outFile, context);
    const unsealer = new Unsealer({ keyPair: key_pair, context });
    rs.pipe(unsealer).pipe(ws);

    await new Promise((resolve, reject) => {
      ws.on('finish', resolve);
      ws.on('error', reject);
      rs.on('error', reject);
      unsealer.on('error', reject);
    });

    expect(Buffer.compare(fs.readFileSync(outFile), srcData)).toBe(0);
    expect(context.context.readItemCount).toBe(totalItems);

    for (const f of [srcFile, sealedFile, outFile, ctxFile]) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }, 20000);
});

describe('createInactivityWatchdog', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('fires once after inactivity and is silenced by kick/stop', () => {
    const onStall = jest.fn();
    const wd = createInactivityWatchdog(1000, onStall);

    wd.kick();
    jest.advanceTimersByTime(900);
    wd.kick(); // activity resets the timer
    jest.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();

    jest.advanceTimersByTime(200); // 1100ms since last kick
    expect(onStall).toHaveBeenCalledTimes(1);

    wd.stop();
    wd.kick();
    jest.advanceTimersByTime(5000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  test('ms of 0 disables the watchdog', () => {
    const onStall = jest.fn();
    const wd = createInactivityWatchdog(0, onStall);
    wd.kick();
    jest.advanceTimersByTime(60_000);
    expect(onStall).not.toHaveBeenCalled();
    wd.stop();
  });
});
