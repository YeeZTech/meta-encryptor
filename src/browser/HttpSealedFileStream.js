/**
 * HttpSealedFileStream — a ReadableStream that fetches a sealed file from a URL
 * and streams its raw content (header + data, skipping block-info bytes).
 *
 * Analogous to Node's SealedFileStream but works over HTTP with Range requests.
 *
 * Usage:
 *   const stream = new HttpSealedFileStream('https://example.com/file.sealed');
 *   stream.pipeThrough(new Unsealer({ privateKeyHex: '…' }))
 *         .pipeTo(new WritableStream({ write(chunk) { … } }));
 */

import { HeaderSize, BlockInfoSize } from '../common/limits.js';
import { validateHeader } from '../common/unsealer_core.js';

const DEFAULT_CHUNK = 1024 * 1024; // 1 MB per Range request

export class HttpSealedFileStream extends ReadableStream {
  /**
   * @param {string} url - URL of the sealed file (must support HEAD + Range)
   * @param {object} [options]
   * @param {number} [options.chunkSize] - bytes per Range request (default 1 MB)
   * @param {Function} [options.fetch] - fetch impl (defaults to globalThis.fetch)
   */
  constructor(url, { chunkSize = DEFAULT_CHUNK, fetch: fetchFn } = {}) {
    const _fetch = fetchFn || fetch.bind(globalThis);
    const state = {
      url,
      totalSize: 0,
      blockNumber: 0,
      contentSize: 0,
    };

    const CHUNK = chunkSize;

    super({
      start: async (controller) => {
        // 1. HEAD 获取文件大小
        const headResp = await _fetch(url, { method: 'HEAD' });
        if (!headResp.ok) {
          controller.error(new Error(`HTTP ${headResp.status}: ${headResp.statusText}`));
          return;
        }
        const totalSize = parseInt(headResp.headers.get('Content-Length') || '0', 10);
        if (totalSize < HeaderSize) {
          controller.error(new Error('File too small for sealed format'));
          return;
        }
        state.totalSize = totalSize;

        // 2. 读取末尾 header
        const tailStart = totalSize - HeaderSize;
        const tailResp = await _fetch(url, {
          headers: { Range: `bytes=${tailStart}-${totalSize - 1}` }
        });
        if (!tailResp.ok) {
          controller.error(new Error('Failed to read tail header'));
          return;
        }
        const headerBuf = new Uint8Array(await tailResp.arrayBuffer());
        if (headerBuf.length !== HeaderSize) {
          controller.error(new Error('Incomplete tail header'));
          return;
        }

        // 3. 解析 header → blockNumber
        const dv = new DataView(headerBuf.buffer, headerBuf.byteOffset, headerBuf.byteLength);
        const lo = dv.getUint32(16, true);
        const hi = dv.getUint32(20, true);
        state.blockNumber = hi * 0x100000000 + lo;

        // 4. 发送 header 到前端
        controller.enqueue(headerBuf);

        // 5. 计算内容区间
        state.contentSize = totalSize - HeaderSize - BlockInfoSize * state.blockNumber;
        if (state.contentSize <= 0) {
          controller.error(new Error('Invalid sealed file: content size is zero or negative'));
          return;
        }

        // 5. 分段 Range 读取内容（跳过 block-info 字节）
        let pos = 0;
        while (pos < state.contentSize) {
          const chunkEnd = Math.min(pos + CHUNK, state.contentSize);
          const resp = await _fetch(url, {
            headers: { Range: `bytes=${pos}-${chunkEnd - 1}` }
          });
          if (!resp.ok) {
            controller.error(new Error(`Range request failed at byte ${pos}`));
            return;
          }
          const buf = new Uint8Array(await resp.arrayBuffer());
          if (buf.length > 0) {
            controller.enqueue(buf);
          }
          pos = chunkEnd;
        }

        controller.close();
      }
    });

    // expose state via public getters
    this.url = url;
    this.totalSize = state.totalSize;
    this.blockNumber = state.blockNumber;
    this.contentSize = state.contentSize;
  }
}

export default HttpSealedFileStream;
