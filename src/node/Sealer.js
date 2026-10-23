import { Transform } from "stream";
import Provider from "./DataProvider.js";
import YPCNt_Object from "../common/ypcntobject.js"
import { DefaultStreamHighWaterMark, MaxItemSize } from "../common/limits.js";
import { getSecp256k1Implementation } from "./secp256k1Impl.js";
import { MetaEncryptorError } from "../common/errors.js";

const {
  DataProvider,
  unsealData,
  checkSealedData,
  headerAndBlockBufferFromFile
} = Provider;

const YPCNtObject = YPCNt_Object()

/**
 * DataProvider.sealData 的输出目标：只需要 write(buf)。
 * 之前用 memory-streams 的 WritableStream，每个 item 要走 2~3 次 stream.Writable
 * 的完整写入流程再 toBuffer()；这里直接收集分片，最后拼一次。
 */
class BufferCollector {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  write(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.parts.push(b);
    this.length += b.length;
    return true;
  }
  toBuffer() {
    if (this.parts.length === 1) return this.parts[0];
    return Buffer.concat(this.parts, this.length);
  }
}
export class ToString extends Transform {
  constructor(options, schema) {
    super({
      ...options,
      objectMode: true
    })
    this.schema = schema;
  }
  _transform(chunk, encoding, callback) {
    let vs = []
    for (const key in chunk) {
      let item = chunk[key];
      if (item.includes(",")) {
        item = "\"" + item + "\"";
      }
      vs.push(item);
    }
    let line = vs.join(",");
    line = line + "\n";
    //let inputNt = YPCNtObject.autoGenerateBytes(vs);
    this.push(line);
    callback();
  }
}
export class CSVSealer extends Transform {
  constructor(options) {
    super(options);
    this.keyPair = options.keyPair;
    this.DP = new DataProvider(this.keyPair, { hashProvider: options.hashProvider });
  }

  _transform(chunk, encoding, callback) {
    const rs = new BufferCollector();
    this.DP.sealData(chunk, rs, false);
    if (rs.length > 0) this.push(rs.toBuffer());
    callback();
  }

  _flush(callback) {
    const rs = new BufferCollector();
    this.DP.sealData(null, rs, true);
    if (rs.length > 0) this.push(rs.toBuffer());
    callback();
  }
}

export class Sealer extends Transform {
  /**
   * 输入按固定 MaxItemSize（64 KiB）切分，每段封装成一个 item（最后一段可以更短），
   * 因此 data_hash 只取决于输入内容，与上游分片大小无关；断点续传也依赖这一点。
   *
   * @param {Object} options
   * @param {any} options.keyPair
   * @param {{ keccak256: (data: Uint8Array) => Uint8Array }} [options.hashProvider]
   *   覆盖默认 keccak（Node 默认原生优先）；浏览器构建无此入口。
   * @param {import('./PipelineConext.js').PipelineContext} [options.context]
   *   断点续传上下文（与 RecoverableSourceStream / RecoverableWriteStream 共用）
   * @param {boolean} [options.skipCommittedInput]
   *   输入流从源头开始（例如转码后的文本），由 Sealer 丢弃 context.readStart 之前的字节；
   *   默认 false，即输入已从 readStart 开始（RecoverableSourceStream）
   * @param {(totalItem: number, readItem: number, bytes: number, writeBytes: number) => void} [options.progressHandler]
   *   与 Unsealer 同签名；加密时总 item 数未知，totalItem 恒为 0
   */
  constructor(options) {
    // HWM 对齐 item 大小（见 limits.js）：Node ≤20 默认 16KiB 时，每个 64KiB item
    // 要经历 4 次 _transform / 背压往返；对齐后一次读入即可成一个 item
    super({ highWaterMark: DefaultStreamHighWaterMark, ...options });
    // 累积分片列表，达到阈值时只拼一次（此前每来一块就 Buffer.concat 一次）
    this.accumulatedChunks = [];
    this.accumulatedLength = 0;
    this.threshold = MaxItemSize;
    this.keyPair = options.keyPair;
    this.DP = new DataProvider(this.keyPair, { hashProvider: options.hashProvider });
    getSecp256k1Implementation();

    this._context = options.context || null;
    this._progressHandler = options.progressHandler || null;
    const ctx = this._context && this._context.context ? this._context.context : {};
    this._completed = ctx.completed === true;
    this._itemCount = 0;
    this._inputBytes = 0;
    this._sealedBytes = 0;
    this._skipBytes = 0;
    if (!this._completed) {
      const readStart = Number.isInteger(ctx.readStart) ? ctx.readStart : 0;
      const itemCount = Number.isInteger(ctx.readItemCount) ? ctx.readItemCount : 0;
      const writeStart = Number.isInteger(ctx.writeStart) ? ctx.writeStart : 0;
      if (Math.ceil(readStart / MaxItemSize) !== itemCount || (itemCount === 0 && writeStart !== 0)) {
        throw new MetaEncryptorError('ERR_SEAL_CONTEXT_INVALID', {
          detail: { reason: `readStart ${readStart} / readItemCount ${itemCount}` },
        });
      }
      if (itemCount > 0) {
        this.DP.restoreSealState({
          itemCount,
          sealedBytes: writeStart,
          blockStarts: ctx.blockStarts,
          dataHash: ctx.dataHash,
        });
      }
      this._itemCount = itemCount;
      this._inputBytes = readStart;
      this._sealedBytes = writeStart;
      if (options.skipCommittedInput) this._skipBytes = readStart;
    }
    this._blockNumber = this.DP.header.block_number;
  }

  /** 已封装明文的滚动哈希（即 header.data_hash），续传时从 checkpoint 接着算 */
  get dataHash() {
    return this.DP.data_hash;
  }

  /** 兼容旧字段：外部/测试读取时返回当前累积内容 */
  get accumulatedBuffer() {
    return this.accumulatedChunks.length === 1
      ? this.accumulatedChunks[0]
      : Buffer.concat(this.accumulatedChunks, this.accumulatedLength);
  }

  _takeAccumulated() {
    const buf = this.accumulatedBuffer;
    this.accumulatedChunks = [];
    this.accumulatedLength = 0;
    return buf;
  }

  /**
   * 记录刚封装的一项输出：交给写端的待提交块（写端落盘后据此推进 checkpoint）并上报进度。
   * items=0 表示文件尾（块信息 + header），提交即代表加密完成。
   */
  _track(rawSize, sealedSize, items) {
    this._inputBytes += rawSize;
    this._sealedBytes += sealedSize;
    this._itemCount += items;
    const runtime = this._context && this._context.runtime;
    if (runtime) {
      if (!Array.isArray(runtime.pendingBlocks)) runtime.pendingBlocks = [];
      let checkpoint;
      if (items === 0) {
        checkpoint = { completed: true };
      } else if (this.DP.header.block_number !== this._blockNumber) {
        this._blockNumber = this.DP.header.block_number;
        checkpoint = { blockStarts: this.DP.blockStarts() };
      }
      runtime.pendingBlocks.push({
        rawSize,
        plainSize: sealedSize,
        remainingPlain: sealedSize,
        raw: null,
        items,
        dataHash: items > 0 ? this.DP.data_hash : null,
        checkpoint,
      });
    }
    if (this._progressHandler) {
      this._progressHandler(0, this._itemCount, this._inputBytes, this._sealedBytes);
    }
  }

  _sealRow(row, rs) {
    const before = rs.length;
    this.DP.sealData(row, rs, false);
    this._track(row.length, rs.length - before, 1);
  }

  _transform(chunk, encoding, callback) {
    if (this._completed) {
      callback();
      return;
    }
    if (this._skipBytes > 0) {
      const n = Math.min(this._skipBytes, chunk.length);
      this._skipBytes -= n;
      if (n === chunk.length) {
        callback();
        return;
      }
      chunk = chunk.subarray(n);
    }
    this.accumulatedChunks.push(chunk);
    this.accumulatedLength += chunk.length;
    if (this.accumulatedLength >= this.threshold) {
      const buf = this._takeAccumulated();
      const rs = new BufferCollector();
      let off = 0;
      while (buf.length - off >= this.threshold) {
        this._sealRow(buf.subarray(off, off + this.threshold), rs);
        off += this.threshold;
      }
      if (off < buf.length) {
        this.accumulatedChunks.push(buf.subarray(off));
        this.accumulatedLength = buf.length - off;
      }
      if (rs.length > 0) this.push(rs.toBuffer());
    }
    callback();
  }

  _flush(callback) {
    if (this._completed) {
      callback();
      return;
    }
    const rs = new BufferCollector();
    if (this.accumulatedLength > 0) {
      const row = this._takeAccumulated();
      const before = rs.length;
      this.DP.sealData(row, rs, false);
      this.DP.flushBatch(rs);
      this._track(row.length, rs.length - before, 1);
    }
    const before = rs.length;
    this.DP.sealData(null, rs, true);
    this._track(0, rs.length - before, 0);
    if (rs.length > 0) this.push(rs.toBuffer());
    callback();
  }
}
