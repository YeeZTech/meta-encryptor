import log from 'loglevel';

import fs from 'fs';
import { promisify } from 'util';

import { MetaEncryptorError } from '../common/errors.js';

const open = promisify(fs.open);
const close = promisify(fs.close);
const fsync = promisify(fs.fsync);
const logger = log.getLogger("meta-encryptor/PipelineContext");

/** Windows / sync clients may briefly lock the target during atomic replace. */
const RENAME_TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_RETRY_BASE_MS = 50;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function errnoCode(err) {
    return err && typeof err === 'object' ? err.code : undefined;
}

/**
 * Replace target with tmp via rename; retry transient locks, then copy+unlink fallback.
 * Throws the last error when all attempts fail (hosts may report to Sentry).
 */
async function replaceFileAtomic(tmpPath, targetPath) {
    let lastError;
    for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
        try {
            await fs.promises.rename(tmpPath, targetPath);
            return;
        } catch (err) {
            lastError = err;
            const code = errnoCode(err);
            if (RENAME_TRANSIENT_CODES.has(code) && attempt < RENAME_MAX_ATTEMPTS - 1) {
                await delay(RENAME_RETRY_BASE_MS * (attempt + 1));
                continue;
            }
            break;
        }
    }

    const code = errnoCode(lastError);
    if (RENAME_TRANSIENT_CODES.has(code) || code === 'EXDEV') {
        try {
            await fs.promises.copyFile(tmpPath, targetPath);
            await fs.promises.unlink(tmpPath);
            return;
        } catch (copyErr) {
            throw copyErr;
        }
    }

    throw lastError;
}

function toBinaryChunk(value) {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
}

const DEFAULT_SAVE_FREQUENCY = 32;
const DEFAULT_STRONG_CONSISTENCY = false;

function normalizePipelineContextOptions(options) {
    const opts = options || {};
    const saveFrequency = Number.isInteger(opts.saveFrequency) && opts.saveFrequency > 0
        ? opts.saveFrequency
        : DEFAULT_SAVE_FREQUENCY;
    return {
        ...opts,
        saveFrequency,
        strongConsistency: opts.strongConsistency === true
            ? true
            : DEFAULT_STRONG_CONSISTENCY,
    };
}

export class PipelineContext {
    constructor(options) {
        this.context = {};
        this.options = normalizePipelineContextOptions(options);
        this.runtime = {
            rawCommitted: 0,
            plainCommitted: 0,
            pendingBlocks: [], //[{rawSize, plainSize, remainingPlain, raw}]
            // 上次 checkpoint 存下的待回放密文快照及其起始偏移；
            // checkpoint 重算时用来补全尚未被本轮消费覆盖的尾段
            loadedData: Buffer.alloc(0),
            loadedDataStart: 0
        };
    }

    update(key, value) {
        this.context[key] = value;
    }

    saveContext() {
        throw new MetaEncryptorError('ERR_PIPELINE_CONTEXT_SAVE');
    }

    loadContext() {
        throw new MetaEncryptorError('ERR_PIPELINE_CONTEXT_LOAD');
    }
}

export class PipelineContextInFile extends PipelineContext {
    constructor(filePath, options) {
        super(options);
        this.filePath = filePath;
        this._saveTail = Promise.resolve();
        this._saveDirty = false;
    }

    _buildPayload() {
        const binaryChunks = [];
        const meta = {};
        let offset = 0;

        for (const [key, value] of Object.entries(this.context)) {
            const binary = toBinaryChunk(value);
            if (binary) {
                binaryChunks.push(binary);
                meta[key] = {
                    type: 'binary',
                    offset,
                    length: binary.length
                };
                offset += binary.length;
            } else {
                meta[key] = {
                    type: 'json',
                    value
                };
            }
        }

        const metaStr = JSON.stringify(meta);
        const metaBuffer = Buffer.from(metaStr);
        const metaLength = metaBuffer.length;

        const totalSize = 4 + metaLength + offset;
        const fileBuffer = Buffer.alloc(totalSize);
        fileBuffer.writeUInt32BE(metaLength, 0);
        metaBuffer.copy(fileBuffer, 4);
        let currentOffset = 4 + metaLength;
        for (const chunk of binaryChunks) {
            chunk.copy(fileBuffer, currentOffset);
            currentOffset += chunk.length;
        }

        return fileBuffer;
    }

    async _writeContextAtomic(fileBuffer) {
        const tmpPath = `${this.filePath}.tmp`;

        logger.debug("PipelineContextInFile::saveContext saving to ", this.filePath);

        const fd = await open(tmpPath, 'w');
        try {
            await promisify(fs.write)(fd, fileBuffer, 0, fileBuffer.length, 0);
            // strongConsistency=false（默认）：省略 fsync，降低落盘开销
            if (this.options.strongConsistency) {
                await fsync(fd);
            }
        } finally {
            await close(fd);
        }

        await replaceFileAtomic(tmpPath, this.filePath);
    }

    async _flushAll() {
        while (this._saveDirty) {
            this._saveDirty = false;
            const payload = this._pendingPayload;
            try {
                await this._writeContextAtomic(payload);
            } catch (error) {
                logger.error('PipelineContextInFile::saveContext error:', error.message);
                throw error;
            }
        }
    }

    saveContext() {
        // 同步构建快照：调用方（RecoverableWriteStream checkpoint）刚刚以
        // 原子方式设置好 readStart/writeStart/data，若延迟到异步 flush 时
        // 再读 context，可能混入 Unsealer/ReadStream 的实时更新导致快照不自洽
        this._pendingPayload = this._buildPayload();
        this._saveDirty = true;
        this._saveTail = this._saveTail.then(() => this._flushAll());
        return this._saveTail;
    }

    async loadContext() {
        try {
            await this._saveTail;

            if (!fs.existsSync(this.filePath)) {
                this.context = {};
                this.runtime.rawCommitted = 0;
                this.runtime.plainCommitted = 0;
                this.runtime.pendingBlocks = [];
                this.runtime.loadedData = Buffer.alloc(0);
                this.runtime.loadedDataStart = 0;
                return;
            }

            const fd = await open(this.filePath, 'r');
            const metaLengthBuffer = Buffer.alloc(4);
            await promisify(fs.read)(fd, metaLengthBuffer, 0, 4, 0);
            const metaLength = metaLengthBuffer.readUInt32BE();

            const metaBuffer = Buffer.alloc(metaLength);
            await promisify(fs.read)(fd, metaBuffer, 0, metaLength, 4);
            const meta = JSON.parse(metaBuffer.toString());

            for (const [key, info] of Object.entries(meta)) {
                if (info.type === 'binary') {
                    const buffer = Buffer.alloc(info.length);
                    const bytesRead = await promisify(fs.read)(fd, buffer, 0, info.length, 4 + metaLength + info.offset);
                    if (bytesRead.bytesRead !== info.length) {
                        throw new MetaEncryptorError('ERR_PIPELINE_CONTEXT_INVALID');
                    }
                    this.context[key] = buffer;
                } else {
                    this.context[key] = info.value;
                }
            }

            await close(fd);

            // status/decryptCompleted 是运行期瞬态字段：残留的 status='file'
            // 会让 Unsealer 在回放完成前就用 remaining 覆盖 context.data
            delete this.context.status;
            delete this.context.decryptCompleted;

            const readStart = this.context.readStart || 0;
            const writeStart = this.context.writeStart || 0;
            const data = this.context.data;
            const dataLen = data ? data.length : 0;
            // readStart 指向消费前沿（含待回放密文）；已提交基线要减去回放段
            this.runtime.rawCommitted = readStart - dataLen;
            this.runtime.plainCommitted = writeStart;
            this.runtime.pendingBlocks = [];
            this.runtime.loadedData = dataLen > 0 ? Buffer.from(data) : Buffer.alloc(0);
            this.runtime.loadedDataStart = readStart - dataLen;
        } catch (error) {
            logger.error('PipelineContextInFile::loadContext error:', error.message);
            this.context = {};
            throw error;
        }
    }
}
