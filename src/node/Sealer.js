import { Transform } from "stream";
import Provider from "./DataProvider.js";
import YPCNt_Object from "../common/ypcntobject.js"
import { DefaultStreamHighWaterMark, MaxItemSize } from "../common/limits.js";
import { getSecp256k1Implementation } from "./secp256k1Impl.js";

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
   * @param {Object} options
   * @param {any} options.keyPair
   * @param {{ keccak256: (data: Uint8Array) => Uint8Array }} [options.hashProvider]
   *   覆盖默认 keccak（Node 默认原生优先）；浏览器构建无此入口。
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

  _transform(chunk, encoding, callback) {
    this.accumulatedChunks.push(chunk);
    this.accumulatedLength += chunk.length;
    if (this.accumulatedLength >= this.threshold) {
      const rs = new BufferCollector();
      this.DP.sealData(this._takeAccumulated(), rs, false);
      if (rs.length > 0) this.push(rs.toBuffer());
    }
    callback();
  }

  _flush(callback) {
    const rs = new BufferCollector();
    if (this.accumulatedLength > 0) {
      this.DP.sealData(this._takeAccumulated(), rs, false);
    }
    this.DP.sealData(null, rs, true);
    if (rs.length > 0) this.push(rs.toBuffer());
    callback();
  }
}
