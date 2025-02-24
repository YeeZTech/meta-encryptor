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
    this.processingData = false; // 添加标志位
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
            .catch(callback);
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
    try {
      this.processingData = true;

      // 关闭当前文件句柄
      if (this.fileHandle) {
        await this.fileHandle.close();
        this.fileHandle = null;
      }

      // 只有在非中断状态下才进行文件重命名
      if (!this._isDestroyed) {
        // 重命名临时文件为正式文件
        await fs.promises.rename(this.decryptTmpPath, this.decryptPath);
        // 等待下游处理完成后，删除decrypt文件
        await this._cleanupDecryptFile();
      }

      // 重新初始化，准备下一块数据
      if (!this._isDestroyed) {
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

  async _cleanupDecryptFile() {
    try {
      if (await this._checkFileExists(this.decryptPath)) {
        await fs.promises.unlink(this.decryptPath);
      }
    } catch (err) {
      // 只在非中断状态下记录错误
      if (!this._isDestroyed) {
        log.error('Cleanup decrypt file error:', err);
      }
    }
  }

  _destroy(err, callback) {
    this._isDestroyed = true;
    const cleanup = async () => {
      try {
        if (this.fileHandle) {
          await this.fileHandle.close();
          this.fileHandle = null;
        }

        callback(err);
      } catch (cleanupErr) {
        callback(cleanupErr || err);
      }
    };
    cleanup();
  }

  async _safeUnlink(filePath) {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log.warn(`Failed to delete file ${filePath}:`, error);
      }
    }
  }
  async _checkFileExists(path) {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  _read(size) {
    // 不需要实现，因为在_write中已经处理了数据推送
  }

  _final(callback) {
    this.push(null);
    this._destroy(null, callback);
  }
}
