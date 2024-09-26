import { Writable } from 'stream'
import fs from 'fs'

const log = require("loglevel").getLogger("meta-encryptor/ProgressInfoStream");

function isObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

const lineBreak = '\n'
const splitter = ','
const processItemCount = 5

class UtilsPromise {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export class WriteWithProgressInfo extends Writable {
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
      if (!this.fileHandle) {
        callback(new Error('new ProgressInfoStream().initialize function must be called'))
        return
      }
      const { chunk } = obj
      const chunkLength = chunk.length
      this.fileHandle.write(chunk, 0, chunkLength, this.writeProcessedBytes).then((res) => {
        log.debug('write result bytesWritten', res.bytesWritten)
        this.writeSucceedBytes += chunkLength
        this.emit('progress', this.writeSucceedBytes)
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

export class ProgressInfoStream extends Writable {
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
    if (!options || !options.processFilePath) {
      throw new Error('processFilePath must be passed')
    }
    this.filePath = options.filePath
    this.processFilePath = options.processFilePath
    this.fileProcessInfo = {
      processedBytes: 0,
      readItemCount: 0,
      totalItem: 0,
      writeSucceedBytes: 0,
    }
    this.processFileProcessInfo = {
      writeSucceedBytes: 0
    }
    this.fileStream = null
    this.processFileStream = null
  }

  async _initProcessFile() {
    try {
      await fs.promises.access(this.processFilePath)
    } catch(e) {
      return Promise.resolve()
    }
    try {
      const res = await fs.promises.readFile(this.processFilePath, { encoding: 'utf8' })
      // 将文件内容按换行符拆分成数组，并反向处理
      const lines = res.split(lineBreak).reverse();
      log.debug('[_initProcessFile]', lines)
      let isReadSuccess = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const items = line.split(splitter)
        if (items.length === processItemCount) {
          this.fileProcessInfo.processedBytes = Number(items[0]) || 0
          this.fileProcessInfo.readItemCount = Number(items[1]) || 0
          this.fileProcessInfo.totalItem = Number(items[2]) || 0
          this.fileProcessInfo.writeSucceedBytes = Number(items[3]) || 0
          this._checkProcessInfo()
          isReadSuccess = true
          break
        }
      }
      const data = isReadSuccess ? this._getProcessItem([
        this.fileProcessInfo.processedBytes,
        this.fileProcessInfo.readItemCount,
        this.fileProcessInfo.totalItem,
        this.fileProcessInfo.writeSucceedBytes,
        ''
      ]) : ''
      await fs.promises.writeFile(this.processFilePath, data)
      const info = await fs.promises.stat(this.processFilePath)
      log.info('info.size', info.size)
      this.processFileProcessInfo.writeSucceedBytes = info.size || 0
    } catch(e) {
      log.error('[_initProcessFile] error', e)
      return Promise.reject(e)
    }
  }

  _checkProcessInfo() {
    if (this.fileProcessInfo.writeSucceedBytes <= 0) {
      this.fileProcessInfo.processedBytes = 0
      this.fileProcessInfo.readItemCount = 0
      this.fileProcessInfo.totalItem = 0
      this.fileProcessInfo.writeSucceedBytes = 0
    }
  }

  _getProcessItem(values) {
    return `${values.join(splitter)}${lineBreak}`
  }

  async initialize() {
    try {
      await this._initProcessFile()
      this.emit('processInfoAvailable', this.fileProcessInfo)
      this.fileStream = new WriteWithProgressInfo({
        filePath: this.filePath,
        writeBytes: this.fileProcessInfo.writeSucceedBytes
      });
      this.processFileStream = new WriteWithProgressInfo({
        filePath: this.processFilePath,
        writeBytes: this.processFileProcessInfo.writeSucceedBytes
      });
      await this.fileStream.initialize()
      await this.processFileStream.initialize()
      log.debug('[ProgressInfoStream] initialize success', this.fileProcessInfo)
    } catch(e) {
      log.error(e)
      return Promise.reject(e)
    }
  }

  _write(obj, encoding, callback) {
    try {
      log.debug('Received chunk:', obj);
      if (!this.fileStream || !this.processFileStream) {
        callback(new Error('new ProgressInfoStream().initialize function must be called'))
        return
      }
      const { chunk, processedBytes, readItemCount, totalItem } = obj
      this.fileStream.once('progress', (writeBytes) => {
        this.fileProcessInfo.writeSucceedBytes = writeBytes
        const values = [
          processedBytes,
          readItemCount,
          totalItem,
          writeBytes,
          ''
        ]
        this.processFileStream.write({
          chunk: Buffer.from(this._getProcessItem(values))
        }, encoding, (e) => {
          if (e) {
            callback(e)
          } else {
            this.emit('progress', processedBytes, readItemCount, totalItem, this.fileProcessInfo.writeSucceedBytes)
            callback()
          }
        })
      })
      this.fileStream.write({ chunk }, encoding, (e) => {
        if (e) {
          callback(e)
        }
      })
    } catch(e) {
      log.error('catch', e)
      callback(e)
    }
  }

  _destroy(err, callback) {
    log.debug('[ProgressInfoStream] Entering _destroy with error:', err);
    const fileUtilsPromise = new UtilsPromise();
    const processFileUtilsPromise = new UtilsPromise();
    if (this.fileStream) {
      this.fileStream.destroy(err)
      this.fileStream.on('close', () => {
        fileUtilsPromise.resolve()
      })
    } else {
      fileUtilsPromise.resolve()
    }
    if (this.processFileStream) {
      this.processFileStream.destroy(err)
      this.processFileStream.on('close', () => {
        processFileUtilsPromise.resolve()
      })
    } else {
      processFileUtilsPromise.resolve()
    }
    Promise.all([fileUtilsPromise.promise, processFileUtilsPromise.promise]).then(() => {
      callback(err)
    }).catch((err) => {
      callback(err)
    })
  }
}
