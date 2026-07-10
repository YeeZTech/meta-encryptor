import { Transform } from "stream";
import Provider from "./DataProvider.js";
import streams from 'memory-streams';
import { MaxPlaintextChunkSize } from "../common/limits.js";

const {
  DataProvider,
} = Provider;

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
    this.push(line);
    callback();
  }
}
export class CSVSealer extends Transform {
  constructor(options) {
    super(options);
    this.keyPair = options.keyPair;
    this.DP = new DataProvider(this.keyPair);
  }

  _transform(chunk, encoding, callback) {
    let rs = new streams.WritableStream()
    this.DP.sealData(chunk, rs, false);
    this.push(rs.toBuffer());
    callback();
  }

  _flush(callback) {
    let rs = new streams.WritableStream();
    let ret = this.DP.sealData(null, rs, true);
    this.push(rs.toBuffer());
    callback();
  }
}

export class Sealer extends Transform {
  constructor(options) {
    super(options);
    this.accumulatedBuffer = Buffer.alloc(0);
    this.threshold = MaxPlaintextChunkSize;
    this.keyPair = options.keyPair;
    this.DP = new DataProvider(this.keyPair);
  }

  _transform(chunk, encoding, callback) {
    this.accumulatedBuffer = Buffer.concat([this.accumulatedBuffer, chunk]);
    while (this.accumulatedBuffer.length >= this.threshold) {
      let rs = new streams.WritableStream()
      this.DP.sealData(this.accumulatedBuffer.subarray(0, this.threshold), rs, false);
      const out = rs.toBuffer();
      if (out.length > 0) this.push(Buffer.isBuffer(out) ? out : Buffer.from(out));
      this.accumulatedBuffer = this.accumulatedBuffer.subarray(this.threshold);
    }
    callback();
  }

  _flush(callback) {
    let rs = new streams.WritableStream();
    if (this.accumulatedBuffer.length > 0) {
      this.DP.sealData(this.accumulatedBuffer, rs, false);
    }
    let ret = this.DP.sealData(null, rs, true);
    const out = rs.toBuffer();
    this.push(Buffer.isBuffer(out) ? out : Buffer.from(out));
    this.accumulatedBuffer = Buffer.alloc(0);
    callback();
  }
}
