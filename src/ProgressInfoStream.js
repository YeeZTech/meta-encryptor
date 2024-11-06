import { Writable } from 'stream'
import fs from 'fs'
import waterfallUntil from 'run-waterfall-until'

const log = require("loglevel").getLogger("meta-encryptor/ProgressInfoStream");

function isObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

const lineBreak = '\n'
const splitter = ','
const progressItemCount = 5
const tmpFileSuffix = '.tmp'

class WritableWithProgressInfo extends Writable {
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
    // 检查文件是否存在
    try {
      await fs.promises.access(this.filePath);
    } catch (error) {
      // 文件不存在，创建一个空文件
      await fs.promises.writeFile(this.filePath, '');
    }
    try {
      this.fileHandle = await fs.promises.open(this.filePath, 'r+');
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
        callback(new Error('new WritableWithProgressInfo().initialize function must be called'))
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
    if (!options || !options.progressFilePath) {
      throw new Error('progressFilePath must be passed')
    }
    this.filePath = options.filePath
    this.progressFilePath = options.progressFilePath
    this.progressTmpFilePath = `${options.progressFilePath}${tmpFileSuffix}`
    this.fileProgressInfo = {
      processedBytes: 0,
      readItemCount: 0,
      totalItem: 0,
      writeSucceedBytes: 0,
    }
    this.fileStream = null
  }

  async initialize() {
    try {
      await this._initProgressFile()
      this.emit('progressInfoAvailable', this.fileProgressInfo)
      this.fileStream = new WritableWithProgressInfo({
        filePath: this.filePath,
        writeBytes: this.fileProgressInfo.writeSucceedBytes
      });
      await this.fileStream.initialize()
      log.debug('[ProgressInfoStream] initialize success')
    } catch(e) {
      log.error(e)
      return Promise.reject(e)
    }
  }

  async _initProgressFile() {
    try {
      await fs.promises.access(this.progressFilePath)
    } catch(e) {
      return Promise.resolve()
    }
    try {
      const res = await fs.promises.readFile(this.progressFilePath, { encoding: 'utf8' })
      const items = res.split(splitter)
      if (items.length === progressItemCount) {
        const [processedBytes, readItemCount, totalItem, writeSucceedBytes] = items
        this.fileProgressInfo.processedBytes = Number(processedBytes) || 0
        this.fileProgressInfo.readItemCount = Number(readItemCount) || 0
        this.fileProgressInfo.totalItem = Number(totalItem) || 0
        this.fileProgressInfo.writeSucceedBytes = Number(writeSucceedBytes) || 0
        this._checkProgressInfo()
      }
    } catch(e) {
      log.error('[_initProgressFile] error', e)
      return Promise.reject(e)
    }
  }

  _checkProgressInfo() {
    if (this.fileProgressInfo.writeSucceedBytes <= 0) {
      this.fileProgressInfo.processedBytes = 0
      this.fileProgressInfo.readItemCount = 0
      this.fileProgressInfo.totalItem = 0
      this.fileProgressInfo.writeSucceedBytes = 0
    }
  }

  _getProgressItem(values) {
    return `${values.join(splitter)}${lineBreak}`
  }

  _writeProgressFile(callback) {
    const _this = this
    try {
      const progressTmpFileExecutable = {
        do: async function(res) {
          try {
            log.info('writeFile progressTmpFilePath', res)
            await fs.promises.writeFile(_this.progressTmpFilePath, res)
          } catch(e) {
            return Promise.reject(e)
          }
        }
      }
      
      const progressFileExecutable = {
        do: async function() {
          try {
            await fs.promises.copyFile(_this.progressTmpFilePath, _this.progressFilePath)
          } catch(e) {
            return Promise.reject(e)
          }
        }
      }

      const { processedBytes, readItemCount, totalItem, writeSucceedBytes } = _this.fileProgressInfo
      const data = _this._getProgressItem([
        processedBytes,
        readItemCount,
        totalItem,
        writeSucceedBytes,
        ''
      ])

      waterfallUntil([
        async function(arg, cb) {
          try {
            await progressTmpFileExecutable.do(arg)
            cb(null, false, arg);
          } catch(e) {
            cb(e, true);
          }
        },
        async function (_, cb) {
          try {
            await progressFileExecutable.do()
            cb(null, 'done');
          } catch(e) {
            cb(e, 'done');
          }
        },
      ], data, function(err, result) {
        callback(err)
      })
    } catch(e) {
      callback(e)
    }
  }

  _write(obj, encoding, callback) {
    try {
      log.debug('Received chunk:', obj);
      if (!this.fileStream) {
        callback(new Error('new ProgressInfoStream().initialize function must be called'))
        return
      }
      const { chunk, processedBytes, readItemCount, totalItem } = obj
      this.fileStream.once('progress', (writeBytes) => {
        this.fileProgressInfo.writeSucceedBytes = writeBytes
        this.fileProgressInfo.processedBytes = processedBytes
        this.fileProgressInfo.readItemCount = readItemCount
        this.fileProgressInfo.totalItem = totalItem
        this._writeProgressFile((e) => {
          log.info('_writeProgressFile error', e)
          !e && this.emit('progress', processedBytes, readItemCount, totalItem, this.fileProgressInfo.writeSucceedBytes)
          callback(e)
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
    if (this.fileStream) {
      this.fileStream.destroy(err)
      this.fileStream.on('close', (e) => {
        callback(err)
      })
    } else {
      callback(err)
    }
  }
}
