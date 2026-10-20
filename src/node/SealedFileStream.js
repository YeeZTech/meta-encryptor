import {Readable} from "stream";
import fs from "fs";
import{HeaderSize, BlockInfoSize,
  MagicNum, CurrentBlockFileVersion, DefaultStreamHighWaterMark} from "../common/limits.js";
import { MetaEncryptorError } from '../common/errors.js';
import {
  buffer2header_t
} from "../common/header_util.js"


import { supportsConstruct } from "./utils.js";

import log from "loglevel";
const logger = log.getLogger("meta-encryptor/SealedFileStream");

export class SealedFileStream extends Readable{
  constructor(filePath, options){
    // 每次 _read(size) 对应一次线程池 pread；HWM 对齐 item 大小以减少往返
    super({ highWaterMark: DefaultStreamHighWaterMark, ...options });
    this.filePath = filePath;
    this.isHeaderSent = false;
    this.contentSize= 0;
    this.start = options ? options.start || 0 : 0;
    this.end = options ? options.end : undefined;
    this.startReadPos = 0;
    this.initialized = false;
    this.streamSize = 0;
    logger.debug("SealedFileStream: ", this)
    if (!supportsConstruct()) {
      logger.debug("no support construct");
      this._construct((err) => {
        if (err) {
          this.emit("error", err);
          return;
        }
      })
    } else {
      logger.debug("support construct");
    }
  }

  async _construct(callback) {
    try {
      logger.debug("open file " + this.filePath)
      this.fileHandle = await fs.promises.open(this.filePath, 'r');
      const fileStats = await this.fileHandle.stat();
      this.header = Buffer.alloc(HeaderSize);
      logger.debug("to read, " + fileStats.size);
      await new Promise((resolve, reject)=>{
        this.fileHandle.read(this.header, 0, HeaderSize, fileStats.size - HeaderSize)
        .then(({bytesRead}) =>{
          if(bytesRead!= HeaderSize){
            throw new MetaEncryptorError('ERR_FILE_TOO_SMALL_HEADER');
          }

          const header = buffer2header_t(this.header);

          // 尾部不是 header（文件已被 truncate 成明文 / 下载不完整 / 根本不是密封文件）时
          // version 是个随机大数且已丢精度，日志里光看数字无从判断；带上原始尾部字节
          const tailDetail = () => ({
            filePath: this.filePath,
            fileSize: fileStats.size,
            tailHex: this.header.toString('hex'),
          });
          if (header.version_number != CurrentBlockFileVersion) {
            throw new MetaEncryptorError('ERR_VERSION_MISMATCH', {
              detail: { expected: CurrentBlockFileVersion, actual: header.version_number, ...tailDetail() },
            });
          }
          if(!header.magic_number.equals(MagicNum)){
            throw new MetaEncryptorError('ERR_INVALID_MAGIC', { detail: tailDetail() });
          }
          this.contentSize = fileStats.size - HeaderSize - BlockInfoSize * header.block_number;
          if(this.contentSize <= 0){
            throw new MetaEncryptorError('ERR_INVALID_FILE_SIZE');
          }
          let endPosition = this.end !== undefined ? this.end : this.contentSize;
          this.end = Math.min(endPosition, this.contentSize);
          this.streamSize = HeaderSize + this.end - this.start;
          resolve();
        }).catch(reject);
      });
      this.initialized = true;
      callback();
      this.emit('ready');
    } catch (err) {
      logger.error("got err " + err)
      callback(err);
    }
  }

  _read(size) {
    logger.debug("_read initialized:", this.initialized);
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
      // 整段都会被 pread 覆盖（只 push 实际读到的字节），无需零填充
      const buffer = Buffer.allocUnsafe(size);
      logger.debug("read file from ", this.startReadPos);
      this.fileHandle.read(buffer, 0, size, this.startReadPos)
        .then(({ bytesRead }) => {
          if (bytesRead > 0) {
            logger.debug("read data " + bytesRead + ", " + this.contentSize + ", " + this.startReadPos);
            let reachEnd = false;
            if(this.end - this.startReadPos <= bytesRead){
              bytesRead = this.end - this.startReadPos;
              reachEnd = true;
              logger.debug("reach end");
            }

            logger.debug("push data " + bytesRead);
            this.startReadPos += bytesRead;
            this.push(buffer.subarray(0, bytesRead));
            if(reachEnd){
              logger.debug("reach end done");
              this.push(null);
            }
        } else {
          if(this.startReadPos != this.end){
            throw new MetaEncryptorError('ERR_UNEXPECTED_EOF');
          }
          this.push(null);
        }
      })
      .catch(err => {
        logger.error("err: ", err)
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
