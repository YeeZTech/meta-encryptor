import { Duplex } from 'stream';
import fs from 'fs';

const log = require('loglevel').getLogger('meta-encryptor/DecryptFileStream');

export class DecryptFileStream extends Duplex {
  constructor(options) {
    super({
      objectMode: true,
      allowHalfOpen: true,
    });

    if (!options || !options.decryptPath) {
      throw new Error('decryptPath must be passed');
    }

    this.decryptPath = options.decryptPath;
    this.decryptTmpPath = `${options.decryptPath}.tmp`;
    this.writePosition = 0;
    this.readPosition = 0;
    this.fileHandle = null;
    this.currentChunk = null;
    this.processingData = false;
    this._isDestroyed = false;
    this.retryCount = options.retryCount || 3;
    this.retryDelay = options.retryDelay || 100;
  }

  async initialize() {
    try {
      // 创建新的空文件
      await fs.promises.writeFile(this.decryptTmpPath, '');
      this.currentPath = this.decryptTmpPath;
      this.fileHandle = await fs.promises.open(this.currentPath, 'r+');
      this.writePosition = 0;
      log.debug('DecryptFileStream initialized with empty file');
    } catch (e) {
      log.error('Initialize failed:', e);
      throw e;
    }
  }

  _write(chunk, encoding, callback) {
    if (!this.fileHandle) {
      return callback(new Error('DecryptFileStream must be initialized first'));
    }

    if (this.processingData) {
      return callback(new Error('Still processing previous data'));
    }

    try {
      let buffer;
      if (chunk && chunk.chunk && Buffer.isBuffer(chunk.chunk)) {
        buffer = chunk.chunk;
        this.currentChunk = chunk;
      } else if (Buffer.isBuffer(chunk)) {
        buffer = chunk;
      } else {
        throw new Error(`Invalid chunk format: ${typeof chunk}`);
      }

      // 写入临时文件
      this.fileHandle
        .write(buffer, 0, buffer.length, this.writePosition)
        .then(({ bytesWritten }) => {
          this.writePosition += bytesWritten;
          this.emit('progress', this.writePosition);

          // 将数据传递给下游
          if (this.currentChunk) {
            this.push(this.currentChunk);
          }

          // 准备处理下一块数据
          this._prepareNextChunk()
            .then(() => callback())
            .catch((err) => {
              log.error('Prepare next chunk error:', err);
              callback(err);
            });
        })
        .catch((err) => {
          log.error('Write error:', err);
          callback(err);
        });
    } catch (err) {
      log.error('Data processing error:', err);
      callback(err);
    }
  }

  async _prepareNextChunk() {
    if (this.processingData) {
      return;
    }

    try {
      this.processingData = true;

      // 关闭当前文件句柄
      if (this.fileHandle) {
        await this.fileHandle.close();
        this.fileHandle = null;
      }

      if (!this._isDestroyed) {
        // 尝试重命名文件
        await this._safeRename(this.decryptTmpPath, this.decryptPath);
        // 清理文件
        await this._cleanupDecryptFile();
        // 重新初始化
        await this.initialize();
      }

      this.processingData = false;
    } catch (err) {
      this.processingData = false;
      if (!this._isDestroyed) {
        throw err;
      }
    }
  }

  async _safeRename(oldPath, newPath) {
    for (let i = 0; i < this.retryCount; i++) {
      try {
        // 检查目标文件
        const targetExists = await this._checkFileExists(newPath);
        if (targetExists) {
          await this._safeUnlink(newPath);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // 执行重命名
        await fs.promises.rename(oldPath, newPath);
        return;
      } catch (err) {
        if (i === this.retryCount - 1) {
          throw err;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelay * Math.pow(2, i))
        );
      }
    }
  }

  async _cleanupDecryptFile() {
    try {
      if (await this._checkFileExists(this.decryptPath)) {
        await this._safeUnlink(this.decryptPath);
      }
    } catch (err) {
      if (!this._isDestroyed) {
        log.error('Cleanup decrypt file error:', err);
      }
    }
  }

  _read() {
    // 由于在_write中已经处理了数据推送，这里不需要实现
  }

  _final(callback) {
    this.push(null);
    this._destroy(null, callback);
  }

  _destroy(err, callback) {
    if (this._isDestroyed) {
      return callback(err);
    }

    this._isDestroyed = true;

    const cleanup = async () => {
      try {
        if (this.fileHandle) {
          await this.fileHandle.close();
          this.fileHandle = null;
        }

        // 清理临时文件
        await this._safeUnlink(this.decryptTmpPath);
        callback(err);
      } catch (cleanupErr) {
        callback(cleanupErr || err);
      }
    };

    cleanup();
  }

  async _checkFileExists(path) {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async _safeUnlink(path) {
    try {
      await fs.promises.unlink(path);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log.warn(`Failed to delete file ${path}:`, error);
      }
    }
  }
}
