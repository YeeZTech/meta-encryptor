import { Readable } from 'stream'
import ByteBuffer, { LITTLE_ENDIAN } from "bytebuffer"
import{ HeaderSize, BlockInfoSize, MagicNum, CurrentBlockFileVersion } from "./limits.js"
import { buffer2header_t } from "./header_util.js"
import { gte } from "semver"
import { downloadFileBytes } from './http/downloadFileBytes.js'

var log = require("loglevel").getLogger("meta-encryptor/RemoteSealedFileStream");

function supportsConstruct() {
  // Node.js 15.0.0 引入了 _construct 方法
  return gte(process.version, '15.0.0');
}

export class RemoteSealedFileStream extends Readable{
  constructor(filePath, downloadUrl, options){
    super(options);
    this.filePath = filePath;
    this.downloadUrl = downloadUrl;
    this.isHeaderSent = false;
    this.contentSize= 0;
    this.start = options ? options.start || 0 : 0;
    this.end = options ? options.end : undefined;
    this.startReadPos = 0;
    this.initialized = false;
    if (!supportsConstruct()) {
      log.debug("no support construct");
      this._construct((err) => {
        if (err) {
          this.emit("error", err);
          return;
        }
        this.emit('ready')
      })
    } else {
      log.debug("support construct");
    }
  }

  async _construct(callback) {
    try {
      // 仅仅为了拿到文件大小
      const { fileSize } = await downloadFileBytes(this.downloadUrl, {
        fileName: this.filePath,
        start: 0,
        length: 4
      });
      log.debug("to read, " + fileSize);
      await new Promise((resolve)=>{
        downloadFileBytes(this.downloadUrl, {
          fileName: this.filePath,
          start: fileSize - HeaderSize,
          length: HeaderSize
        }).then(({ bytes }) =>{
          if (bytes.length !== HeaderSize) {
            throw new Error("Cannot read header. File too small");
          }

          this.header = Buffer.from(bytes);

          const header = buffer2header_t(ByteBuffer.wrap(this.header, LITTLE_ENDIAN));

          if (header.version_number != CurrentBlockFileVersion) {
            throw new Error("only support version ", CurrentBlockFileVersion, ", yet got ", header.version_number);
          }
          if(!header.magic_number.equals(MagicNum)){
            throw new Error("Invalid magic number, maybe wrong file");
          }
          this.contentSize = fileSize - HeaderSize - BlockInfoSize * header.block_number;
          if(this.contentSize <= 0){
            throw new Error("Invalid file size.");
          }
          let endPosition = this.end !== undefined ? this.end : this.contentSize;
          this.end = Math.min(endPosition, this.contentSize);
          log.debug('this.end:', this.end)
          log.debug('this.contentSize:', this.contentSize)
          resolve();
        });
      }) ;
      this.initialized = true;
      callback();
    } catch (err) {
      log.error("got err " + err)
      callback(err);
    }
  }

  _read(size) {
    log.debug("_read initialized:", this.initialized, size);
    if (!this.initialized) {
      this.once('ready', () => this._read(size));
      return;
    }
    if(!this.isHeaderSent){
      if(size < HeaderSize - this.startReadPos){
        this.push(this.header.slice(this.startReadPos, this.startReadPos + size));
        this.startReadPos += size;
        if(this.startReadPos == HeaderSize){
          this.startReadPos = this.start;
          this.isHeaderSent = true;
        }
      }else{
        this.push(this.header);
        this.startReadPos = this.start;
        this.isHeaderSent = true;
      }
    }else{
      log.debug("read file from ", this.startReadPos);
      downloadFileBytes(this.downloadUrl, {
        fileName: this.filePath,
        start: this.startReadPos,
        length: size
      }).then(({ bytes }) => {
        let bytesRead = bytes.length
        if (bytesRead > 0) {
          log.debug("read data " + bytesRead + ", " + this.contentSize + ", " + this.startReadPos);
          let reachEnd = false;
          if(this.end - this.startReadPos <= bytesRead){
            bytesRead = this.end - this.startReadPos;
            reachEnd = true;
            log.debug("reach end");
          }

          log.debug("push data " + bytesRead);
          this.startReadPos += bytesRead;
          const buffer = Buffer.from(bytes);
          this.push(buffer.slice(0, bytesRead));
          if(reachEnd){
            log.debug("reach end done");
            this.push(null);
          }
        } else {
          if(this.startReadPos != this.end){
            throw new Error("Does't reach end, yet cannot read more data");
          }
        this.push(null);
      }
      }).catch(err => {
        log.error("err: ", err)
        this.destroy(err);
      });
    }
  }

  _destroy(err, callback) {
    callback(err);
  }
}
