import { createProgressTransformer, createDownloadReadyTransformer } from '../src/common/progress.js';

describe('progress transformers', () => {
  test('createProgressTransformer reports cumulative bytes', async () => {
    const calls = [];
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    writer.write(new Uint8Array(3));
    writer.write(new Uint8Array(2));
    writer.close();

    const reader = readable
      .pipeThrough(createProgressTransformer(10, (total, received) => {
        calls.push([total, received]);
      }))
      .getReader();

    while (!(await reader.read()).done) {}

    expect(calls).toEqual([[10, 3], [10, 5]]);
  });

  test('createDownloadReadyTransformer fires once on first chunk', async () => {
    let readyCount = 0;
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    writer.write(new Uint8Array(64));
    writer.write(new Uint8Array(8));
    writer.close();

    const reader = readable
      .pipeThrough(createDownloadReadyTransformer(() => { readyCount++; }))
      .getReader();

    await reader.read();
    expect(readyCount).toBe(1);
    await reader.read();
    expect(readyCount).toBe(1);
  });

  test('createDownloadReadyTransformer no-ops when callback omitted', async () => {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    writer.write(new Uint8Array(1));
    writer.close();

    const reader = readable
      .pipeThrough(createDownloadReadyTransformer())
      .getReader();

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value.length).toBe(1);
  });
});
