const {
  Transform
} = require('stream');
var log = require("loglevel").getLogger("meta-encryptor/dataprovider");
import Provider from "./DataProvider";
var streams = require('memory-streams');
import YPCNt_Object from "./ypcntobject"

const {
  DataProvider,
  unsealData,
  checkSealedData,
  headerAndBlockBufferFromFile
} = Provider;

const YPCNtObject = YPCNt_Object()
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
    this.threshold = 64 * 1024;
    this.keyPair = options.keyPair;
    this.DP = new DataProvider(this.keyPair);
  }

  _transform(chunk, encoding, callback) {
    this.accumulatedBuffer = Buffer.concat([this.accumulatedBuffer, chunk]);
    if (this.accumulatedBuffer.length >= this.threshold) {
      let rs = new streams.WritableStream()
      this.DP.sealData(this.accumulatedBuffer, rs, false);
      const out = rs.toBuffer();
      this.push(Buffer.isBuffer(out) ? out : Buffer.from(out));
      this.accumulatedBuffer = Buffer.alloc(0);
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
