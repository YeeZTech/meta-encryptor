import { EventEmitter } from 'events';
import fs from 'fs';
import { ProgressInfoStream } from './ProgressInfoStream.js';
import { UnsealerWithProgressInfo } from './UnsealerWithProgressInfo.js';
import { SealedFileStream } from './SealedFileStream.js';
import { DecryptFileStream } from './DecryptFileStream.js';

const log = require('loglevel').getLogger('meta-encryptor/UnsealerWithLocal');

export class UnsealerWithLocal {
  constructor(options) {
    if (!options || !options.filePath || !options.decryptPath) {
      throw new Error('Required options missing');
    }

    this._eventEmitter = new EventEmitter();
    this._isAbort = false;
    this._isCompleted = false;
    this._options = options;
    this._errors = [];
    this._hasError = false;
    this._timeout = options.timeout || 30000;
    this._retryCount = options.retryCount || 3;
    this._metrics = {
      startTime: null,
      endTime: null,
      bytesProcessed: 0,
      processingTime: 0,
    };

    // 文件路径设置
    this._decryptPath = options.decryptPath;
    this._decryptTmpPath = `${options.decryptPath}.tmp`;

    // 流完成标志
    this._inputStreamComplete = false;
    this._unSealerTransformComplete = false;
    this._decryptStreamComplete = false;
    this._writeStreamComplete = false;

    // 初始化流
    this._writeStream = new ProgressInfoStream({
      filePath: this._options.filePath,
      progressFilePath: this._options.progressFilePath,
    });

    this._decryptStream = new DecryptFileStream({
      decryptPath: this._decryptPath,
      retryCount: this._retryCount,
    });

    // 进度信息监听
    this._writeStream.on('progressInfoAvailable', (res) => {
      log.debug('progressInfoAvailable', res);
      this._lastProgressInfo = {
        processedBytes: res.processedBytes,
        readItemCount: res.readItemCount,
        writeSucceedBytes: res.writeSucceedBytes,
      };
    });

    this._initializeProgressInfo();
  }

  async _initializeProgressInfo() {
    try {
      // 检查文件状态确定恢复点
      const hasIndexTmp = await this._checkFileExists(
        this._options.progressFilePath + '.tmp'
      );
      const hasDecryptTmp = await this._checkFileExists(this._decryptTmpPath);
      const hasDecrypt = await this._checkFileExists(this._decryptPath);

      if (hasIndexTmp) {
        // 使用index.tmp的进度
        this._lastProgressInfo = await this._readProgressInfo(
          this._options.progressFilePath + '.tmp'
        );
      } else if (hasDecryptTmp || hasDecrypt) {
        // 使用decrypt相关文件的大小作为进度
        const size = await this._getFileSize(
          hasDecryptTmp ? this._decryptTmpPath : this._decryptPath
        );
        this._lastProgressInfo = {
          processedBytes: size,
          readItemCount: Math.floor(size / this._options.blockSize),
          writeSucceedBytes: size,
        };
      } else {
        // 从头开始
        this._lastProgressInfo = {
          processedBytes: 0,
          readItemCount: 0,
          writeSucceedBytes: 0,
        };
      }
    } catch (err) {
      this._handleError(err, 'initializeProgressInfo');
    }
  }

  async _createdInputStream() {
    try {
      this._inputStream = new SealedFileStream(this._options.filePath, {
        start: this._lastProgressInfo.processedBytes,
        highWaterMark: parseInt(64 * 1024, 10),
      });
    } catch (e) {
      this._handleError(e, 'createdInputStream');
    }
  }

  _setupStreamEvents() {
    // 输入流事件
    this._inputStream.on('close', (e) => {
      log.info('[UnsealerWithLocal] inputStream close e', e);
    });

    this._inputStream.on('end', () => {
      log.info('[UnsealerWithLocal] inputStream end');
      this._inputStreamComplete = true;
    });

    this._inputStream.on('error', (e) => {
      this._handleError(e, 'inputStream');
    });

    // 解密转换流事件
    this._unSealerTransform.on('end', () => {
      log.info('[UnsealerWithLocal] unSealerTransform end');
      this._unSealerTransformComplete = true;
    });

    this._unSealerTransform.on('error', (e) => {
      this._handleError(e, 'unSealerTransform');
    });

    // 解密流事件
    this._decryptStream.on('progress', (writeBytes) => {
      log.info('[UnsealerWithLocal] decryptStream progress', writeBytes);
      this._lastProgressInfo.writeSucceedBytes = writeBytes;
      this._metrics.bytesProcessed = writeBytes;
      this._emit('decryptProgress', writeBytes);
    });

    this._decryptStream.on('end', () => {
      log.info('[UnsealerWithLocal] decryptStream end');
      this._decryptStreamComplete = true;
    });

    this._decryptStream.on('error', (e) => {
      this._handleError(e, 'decryptStream');
    });

    // 写入流事件
    this._writeStream.on(
      'progress',
      (processedBytes, readItemCount, totalItem, writeSucceedBytes) => {
        this._progressHandler(
          totalItem,
          readItemCount,
          processedBytes,
          writeSucceedBytes
        );
      }
    );

    this._writeStream.on('close', () => {
      log.info(
        '[UnsealerWithLocal] writeStream close this._isAbort',
        this._isAbort
      );
      this._writeStreamComplete = true;

      this._metrics.endTime = Date.now();
      this._metrics.processingTime =
        this._metrics.endTime - this._metrics.startTime;

      if (
        !this._isAbort &&
        !this._hasError &&
        this._inputStreamComplete &&
        this._unSealerTransformComplete &&
        this._decryptStreamComplete
      ) {
        this._isCompleted = true;
      }

      this._emit('close', {
        isCompleted: this._isCompleted,
        isAborted: this._isAbort,
        hasError: this._hasError,
        writeBytes: this._lastProgressInfo.writeBytes,
        metrics: this._metrics,
      });
    });

    this._writeStream.on('error', (e) => {
      this._handleError(e, 'writeStream');
    });
  }

  _start() {
    this._inputStream
      .pipe(this._unSealerTransform)
      .pipe(this._decryptStream)
      .pipe(this._writeStream);

    this._setupStreamEvents();
    log.debug('Pipe chain established');
  }

  _progressHandler(totalItem, readItem, bytes, writeBytes) {
    this._totalItems = totalItem;
    this._lastProgressInfo.processedBytes = bytes;
    this._lastProgressInfo.processedItems = readItem;
    this._lastProgressInfo.writeBytes = writeBytes;
    this._emitProgress();
  }

  _emitProgress() {
    const progress = {
      ...this._lastProgressInfo,
      percentage:
        (this._lastProgressInfo.readItemCount / this._totalItems) * 100,
      isCompleted: this._isCompleted,
      isAborted: this._isAbort,
      hasError: this._hasError,
      metrics: this._metrics,
    };
    this._emit('progress', progress);
  }

  _handleError(error, source) {
    this._hasError = true;
    this._errors.push({
      source,
      error,
      timestamp: new Date(),
    });
    this._emit('error', error);
  }

  async _cleanup() {
    try {
      const cleanupTasks = [];

      if (this._writeStream) {
        cleanupTasks.push(
          new Promise((resolve) => {
            this._writeStream.once('close', resolve);
            this._writeStream.destroy();
          })
        );
      }

      if (this._decryptStream) {
        cleanupTasks.push(
          new Promise((resolve) => {
            this._decryptStream.once('close', resolve);
            this._decryptStream.destroy();
          })
        );
      }

      if (this._inputStream) {
        cleanupTasks.push(
          new Promise((resolve) => {
            this._inputStream.once('close', resolve);
            this._inputStream.destroy();
          })
        );
      }

      if (this._unSealerTransform) {
        cleanupTasks.push(
          new Promise((resolve) => {
            this._unSealerTransform.once('close', resolve);
            this._unSealerTransform.destroy();
          })
        );
      }

      await Promise.all(cleanupTasks);
    } catch (err) {
      log.error('Cleanup error:', err);
    }
  }

  async _retryOperation(operation) {
    let lastError;
    for (let i = 0; i < this._retryCount; i++) {
      try {
        return await Promise.race([
          operation(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Operation timeout')),
              this._timeout
            )
          ),
        ]);
      } catch (err) {
        lastError = err;
        log.warn(`Retry attempt ${i + 1} failed:`, err);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, i) * 1000)
        );
      }
    }
    throw lastError;
  }

  // 公共方法
  async start() {
    this._metrics.startTime = Date.now();

    try {
      await this._retryOperation(async () => {
        await this._writeStream.initialize();
        await this._decryptStream.initialize();
        await this._createdInputStream();
      });

      this._unSealerTransform = new UnsealerWithProgressInfo({
        keyPair: {
          private_key: this._options.privateKey,
          public_key: this._options.publicKey,
        },
        processedItemCount: this._lastProgressInfo.readItemCount,
        processedBytes: this._lastProgressInfo.processedBytes,
        writeBytes: this._lastProgressInfo.writeSucceedBytes,
      });

      this._start();
    } catch (err) {
      this._handleError(err, 'start');
      throw err;
    }
  }

  async abort() {
    this._isAbort = true;
    this._isCompleted = false;
    await this._cleanup();
    return {
      ...this._lastProgressInfo,
      isAborted: true,
      isCompleted: false,
      hasError: this._hasError,
      metrics: this._metrics,
    };
  }

  async reset() {
    this._isAbort = false;
    this._isCompleted = false;
    this._hasError = false;
    this._errors = [];
    this._inputStreamComplete = false;
    this._unSealerTransformComplete = false;
    this._decryptStreamComplete = false;
    this._writeStreamComplete = false;

    await this._cleanup();
    await this._initializeProgressInfo();

    this._metrics = {
      startTime: null,
      endTime: null,
      bytesProcessed: 0,
      processingTime: 0,
    };
  }

  // 事件相关方法
  _emit(event, ...args) {
    this._eventEmitter.emit(event, ...args);
  }

  on(event, listener) {
    this._eventEmitter.on(event, listener);
    return this;
  }

  once(event, listener) {
    this._eventEmitter.once(event, listener);
    return this;
  }

  // 状态检查方法
  isComplete() {
    return this._isCompleted;
  }

  isAborted() {
    return this._isAbort;
  }

  hasError() {
    return this._hasError;
  }

  getErrors() {
    return [...this._errors];
  }

  getProgress() {
    return {
      ...this._lastProgressInfo,
      percentage:
        (this._lastProgressInfo.readItemCount / this._totalItems) * 100,
      isCompleted: this._isCompleted,
      isAborted: this._isAbort,
      hasError: this._hasError,
      metrics: { ...this._metrics },
    };
  }

  // 辅助方法
  async _checkFileExists(path) {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async _getFileSize(path) {
    const stats = await fs.promises.stat(path);
    return stats.size;
  }

  async _readProgressInfo(path) {
    try {
      const content = await fs.promises.readFile(path, 'utf8');
      const [processedBytes, readItemCount, totalItem, writeSucceedBytes] =
        content.split(',').map(Number);
      return {
        processedBytes,
        readItemCount,
        writeSucceedBytes,
      };
    } catch (e) {
      log.error('Error reading progress info:', e);
      return {
        processedBytes: 0,
        readItemCount: 0,
        writeSucceedBytes: 0,
      };
    }
  }
}
