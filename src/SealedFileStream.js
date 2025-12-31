const {
  Readable
} = require('stream');
const fs = require('fs');
import{HeaderSize, BlockInfoSize,
  MagicNum, CurrentBlockFileVersion} from "./limits.js";
import {
  buffer2header_t
} from "./header_util.js"

const {supportsConstruct} =require( "./utils.js")


var log = require("loglevel").getLogger("meta-encryptor/SealedFileStream");

export class SealedFileStream extends Readable{
  constructor(filePath, options){
    super(options);
    this.filePath = filePath;
    this.isHeaderSent = false;
    this.contentSize= 0;
    this.start = options ? options.start || 0 : 0;
    this.end = options ? options.end : undefined;
    this.startReadPos = 0;
    this.initialized = false;
    this.streamSize = 0;
    log.debug("SealedFileStream: ", this)
    if (!supportsConstruct()) {
      log.debug("no support construct");
      this._construct((err) => {
        if (err) {
          this.emit("error", err);
          return;
        }
      })
    } else {
      log.debug("support construct");
    }
  }

  async _construct(callback) {
    try {
      log.debug("open file " + this.filePath)
      this.fileHandle = await fs.promises.open(this.filePath, 'r');
      const fileStats = await this.fileHandle.stat();
      this.header = Buffer.alloc(HeaderSize);
      log.debug("to read, " + fileStats.size);
      await new Promise((resolve)=>{
        this.fileHandle.read(this.header, 0, HeaderSize, fileStats.size - HeaderSize)
        .then(({bytesRead}) =>{
          if(bytesRead!= HeaderSize){
            throw new Error("Cannot read header. File too small");
          }

          const header = buffer2header_t(this.header);

          if (header.version_number != CurrentBlockFileVersion) {
            throw new Error("only support version ", CurrentBlockFileVersion, ", yet got ", header.version_number);
          }
          if(!header.magic_number.equals(MagicNum)){
            throw new Error("Invalid magic number, maybe wrong file");
          }
          this.contentSize = fileStats.size - HeaderSize - BlockInfoSize * header.block_number;
          if(this.contentSize <= 0){
            throw new Error("Invalid file size.");
          }
          let endPosition = this.end !== undefined ? this.end : this.contentSize;
          this.end = Math.min(endPosition, this.contentSize);
          this.streamSize = HeaderSize + this.end - this.start;
          resolve();
        });
      }) ;
      this.initialized = true;
      callback();
      this.emit('ready');
    } catch (err) {
      log.error("got err " + err)
      callback(err);
    }
  }

  _read(size) {
    log.debug("_read initialized:", this.initialized);
    if (!this.initialized && !supportsConstruct()) {
      this.once('ready', () => this._read(size));
      return;
    }
    if(!this.isHeaderSent){
      if(size < HeaderSize - this.startReadPos){
        this.push(this.header.subarray(this.startReadPos, this.startReadPos + size));
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
      const buffer = Buffer.alloc(size);
      log.debug("read file from ", this.startReadPos);
      this.fileHandle.read(buffer, 0, size, this.startReadPos)
        .then(({ bytesRead }) => {
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
            this.push(buffer.subarray(0, bytesRead));
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
      })
      .catch(err => {
        log.error("err: ", err)
        this.destroy(err);
      });
    }
  }

  _destroy(err, callback) {
    log.debug('Entering _destroy with error:', err);
    if (this.fileHandle) {
      this.fileHandle.close()
        .then(() => {
          log.debug('File handle closed successfully.');
          callback(err);
        })
        .catch(err => {
          log.error('Error closing file handle:', err);
          callback(err);
        });
    } else {
      log.debug('No file handle to close.');
      callback(err);
    }
  }
}
