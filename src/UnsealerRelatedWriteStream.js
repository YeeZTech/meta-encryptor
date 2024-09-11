import { Writable } from 'stream'
import fs from 'fs'
const log = require("loglevel").getLogger("meta-encryptor/UnsealerRelatedWriteStream");

function isObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export class UnsealerRelatedWriteStream extends Writable {
  constructor(options, writableOptions) {
    if (isObject(writableOptions)) {
      writableOptions.objectMode = true
    } else {
      writableOptions = {
        objectMode: true
      }
    }
    super(writableOptions);
    if (!options || !options.filePath) {
      throw new Error('filePath must be passed')
    }
    if (options.writeBytes && (typeof options.writeBytes !== 'number' || options.writeBytes < 0)) {
      throw new Error('writeBytes must be a number and >= 0')
    }
    this.filePath = options.filePath
    this.writeProcessedBytes = options.writeBytes || 0
    this.writeSucceedBytes = options.writeBytes || 0
    this.initialized = false
    this.fileHandle = null
  }

  async initialize() {
    try {
      this.fileHandle = await fs.promises.open(this.filePath, 'a+');
      log.debug('initialize success')
    } catch(e) {
      log.error(e)
      return Promise.reject(e)
    }
  }

  _write(obj, _, callback) {
    try {
      log.debug('Received chunk:', obj);
      const { chunk, processedBytes, readItemCount, totalItem } = obj
      const chunkLength = chunk.length
      this.fileHandle.write(chunk, 0, chunkLength, this.writeProcessedBytes).then((res) => {
        log.debug('write result bytesWritten', res.bytesWritten)
        this.writeSucceedBytes += chunkLength
        this.emit('progress', processedBytes, readItemCount, totalItem, this.writeSucceedBytes)
        callback();
      }).catch((e) => {
        log.error('write catch', e)
        callback(e)
      })
      this.writeProcessedBytes += chunkLength
    } catch(e) {
      log.error('catch', e)
      callback(e)
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