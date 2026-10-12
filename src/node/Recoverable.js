import {WriteStream} from 'fs';
import {Readable, Writable} from 'stream';
import { SealedFileStream } from './SealedFileStream.js';
import { HeaderSize, DefaultStreamHighWaterMark } from '../common/limits.js';
import fs from 'fs';
import path from 'path';
import log from 'loglevel';

const logger = log.getLogger("meta-encryptor/Recoverable");

export class RecoverableReadStream extends Readable {
    constructor(filePath, context, options) {
        // HWM 对齐 item 大小（见 limits.js），每个 item 的线程池往返从 4~5 次降到 1~2 次
        super({ highWaterMark: DefaultStreamHighWaterMark, ...options });
        this.options = options;
        this.context = context;
        // 记录读端文件路径；写端据此识别 inplace（读写同一文件）并启用写前存档
        if (context && context.runtime) {
            context.runtime.readFilePath = path.resolve(filePath);
        }
        this.inputStream = new SealedFileStream(filePath, {
            start: this._getReadStartInContext(),
            highWaterMark: this.readableHighWaterMark
        });
        this.state = 'header';
        this.headerRead = 0;

        this.inputStream.on('error', (err) => {
            this.emit('error', err);
        });
        this.inputStream.on('end', () => {
            if (this.state === 'remaining') {
                this.push(null);
            }
            if (this.inputStream && typeof this.inputStream.destroy === 'function') {
                this.inputStream.destroy();
            }
        });
    }

    _getReadStartInContext() {
        if (
            this.context.context === null ||
            this.context.context === undefined ||
            this.context.context.readStart === undefined ||
            Object.keys(this.context.context).length === 0
        ) {
            logger.debug("No readStart in context, start from 0");
            return 0;
        }
        logger.debug("Resuming read from position:", this.context.context['readStart']);
        return this.context.context['readStart'];
    }
    _getDataInContext() {
        if (
            this.context.context === null ||
            this.context.context === undefined ||
            Object.keys(this.context.context).length === 0 ||
            this.context.context['data'] === null ||
            this.context.context['data'] === undefined
        ) {
            logger.debug("No data in context, returning empty buffer");
            return Buffer.alloc(0);
        }
        logger.debug("Getting data from context, length:", this.context.context['data'].length);
        return this.context.context['data'];
    }
    _read(size) {
        switch (this.state) {
            case 'header':
                const headerChunk = this.inputStream.read(Math.min(HeaderSize - this.headerRead, size));
                if (headerChunk) {
                    this.headerRead += headerChunk.length;
                    this.push(headerChunk);
                    if (this.headerRead === HeaderSize) {
                        this.state = 'contextData';
                    }
                } else {
                    this.inputStream.once('readable', () => {
                        this._read(size);
                    });
                }
                logger.debug("Reading header, read so far:", this.headerRead);
                break;
            case 'contextData':
                this.context.context['status'] = 'context';
                const contextData = this._getDataInContext();
                if (contextData.length > 0) {
                    const chunkSize = Math.min(contextData.length, size);
                    const chunk = contextData.slice(0, chunkSize);
                    this.context.context['data'] = contextData.slice(chunkSize);
                    this.push(chunk);
                    if (this.context.context['data'].length === 0) {
                        this.state = 'remaining';
                    }
                } else {
                    this.state = 'remaining';
                    this._read(size);
                }
                logger.debug("Reading context data, remaining length:", this.context.context['data'] ? this.context.context['data'].length : 0);
                break;
            case 'remaining':
                this.context.context['status'] = 'file';
                const remainingChunk = this.inputStream.read(size);
                if (remainingChunk) {
                    if (
                        this.context.context['readStart'] === undefined ||
                        typeof this.context.context['readStart'] !== 'number' ||
                        isNaN(this.context.context['readStart'])
                    ) {
                        this.context.context['readStart'] = 0;
                    }
                    this.context.context['readStart'] += remainingChunk.length;
                    const prevData = this.context.context['data'] || Buffer.alloc(0);
                    this.context.context['data'] = Buffer.concat([prevData, remainingChunk]);
                    logger.debug("Updated readStart in context to:", this.context.context['readStart'], " data length to:", this.context.context['data'].length);
                    
                    this.push(remainingChunk);
                } else {
                    if (this.inputStream.readableEnded) {
                        //console.log("push null")
                        this.push(null);
                    } else {
                        this.inputStream.once('readable', () => {
                            this._read(size);
                        });
                    }
                }
                logger.debug("Reading remaining data from file");
                break;
        }
    }

    _destroy(err, callback) {
        if (this.inputStream && typeof this.inputStream.destroy === 'function') {
            this.inputStream.destroy();
        }
        callback(err);
    }
}

/**
 * Structured fields for fs / write-stream failures (Sentry / electron-log).
 * Prefer this over logging the raw Error alone — Windows often surfaces only
 * UNKNOWN/-4094 without a useful message unless code/errno/syscall/path are kept.
 */
function formatWriteFsError(err, op, extra = {}) {
    const out = {
        op,
        message: err && err.message,
        name: err && err.name,
        code: err && err.code,
        errno: err && err.errno,
        syscall: err && err.syscall,
        path: (err && err.path) || extra.path,
        ...extra,
    };
    return out;
}

/** Path-truncate attempts after close when ftruncate(fd) is unavailable/failed. */
const PATH_TRUNCATE_RETRY_DELAYS_MS = [50, 150];

/**
 * 写端允许"已交给 fs.WriteStream 但 pwrite 尚未完成"的明文上限。
 * 双文件（密文 ≠ 输出）场景 checkpoint 不需要随身携带这些 item 的密文，可以放宽，
 * 足以吸收 OS 对增长中文件的写入节流停顿（实测 5~50ms）；
 * inplace 场景 pending 密文必须进 checkpoint（见 _syncContextCheckpoint），
 * 为控制 .progress 体积只放少量 item。
 */
const DEFAULT_MAX_INFLIGHT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_INFLIGHT_BYTES_INPLACE = 256 * 1024;

export class RecoverableWriteStream extends Writable {
    /**
     * @param {string} filePath
     * @param {import('./PipelineConext.js').PipelineContext} context
     * @param {object} [options] stream.Writable 选项，另支持：
     *   - maxInflightBytes：覆盖默认的在途明文上限（双文件 4MiB / inplace 256KiB）
     */
    constructor(filePath, context, options) {
        const { maxInflightBytes, ...streamOpts } = options || {};
        super({ highWaterMark: DefaultStreamHighWaterMark, ...streamOpts });
        this.options = options;
        this.context = context;
        this.filePath = filePath;
        /** Prevent overlapping _final work. */
        this._finalizeStarted = false;

        // 写完成与流水线解耦：chunk 交给底层 fs.WriteStream 即 ack，
        // 账本提交 / checkpoint 落盘在真实写回调里进行；在途字节数以此为界
        this._maxInflightBytesOption = Number.isInteger(maxInflightBytes) && maxInflightBytes > 0
            ? maxInflightBytes : null;
        this._inflightBytes = 0;
        /** 唯一可能挂起的 _write callback（Writable 串行调用 _write） */
        this._inflightWaiter = null;
        /** 首个写入 / 后台落盘错误；一旦出现，流即 destroy */
        this._pendingError = null;
        this._lastSaveAt = 0;

        const writeStart = this._getWriteStartInContext();
        const fileExists = fs.existsSync(filePath);
        // Keep default autoClose: true. On 'finish', ftruncateSync(fd) runs
        // synchronously while the write fd is still open; autoClose then
        // releases it. Avoid path fs.truncate() in that window (Windows
        // UNKNOWN/-4094 when AV / cloud sync races a re-open).
        let streamOptions = {};
        if (fileExists) {
            this.fileSize = fs.statSync(filePath).size;
            if (writeStart > 0) {
                streamOptions = {
                    flags: 'r+',
                    start: writeStart
                };
                logger.debug(`Opening file ${filePath} for resuming write at position: ${writeStart}`);
            } else {
                streamOptions = {
                    flags: 'r+',
                    start: 0
                };
                logger.debug(`File is empty. Creating new file ${filePath} for writing`);
            }
        } else {
            fs.writeFileSync(filePath, '');
            this.fileSize = 0;

            streamOptions = {
                flags: 'r+',
                start: 0
            };
            logger.debug(`File not exist.Created new file ${filePath} for writing`);
        }
        // 底层 fs.WriteStream 只负责排队 pwrite；背压由本类的在途字节数控制，
        // 其 highWaterMark 放大到与在途上限同量级即可（不依赖它的 'drain'）
        this.writeStream = new WriteStream(filePath, {
            ...streamOptions,
            highWaterMark: DEFAULT_MAX_INFLIGHT_BYTES
        });
        // 自上次 saveContext 以来已提交但尚未落盘的 item 数；默认每 32 个落盘一次
        this._unsavedItemCount = 0;

        // 写前存档（WAL）状态：inplace 场景下，任何明文写入若将触及
        // 「最后一份已落盘存档的 readStart」之后的区域（那里的密文尚无
        // 存档保护），必须先存档再写。
        this._resolvedPath = path.resolve(filePath);
        this._writePos = writeStart;
        const ctx0 = context && context.context;
        this._savedReadStart =
            ctx0 && Number.isInteger(ctx0.readStart) ? ctx0.readStart : 0;

        this.writeStream.on('error', (err) => {
            this._failPipeline(err);
        });
    }

    /** 是否 inplace（读写同一文件）；读端构造时才会登记路径，故按需判断 */
    _isInplace() {
        const runtime = this.context && this.context.runtime;
        return !!(runtime && runtime.readFilePath === this._resolvedPath);
    }

    _maxInflightBytes() {
        if (this._maxInflightBytesOption) return this._maxInflightBytesOption;
        return this._isInplace() ? DEFAULT_MAX_INFLIGHT_BYTES_INPLACE : DEFAULT_MAX_INFLIGHT_BYTES;
    }

    /**
     * 写入或后台落盘出错：记录首个错误并 destroy 本流（只触发一次 'error'）。
     * 挂起的 _write callback 由 _releaseInflightWaiter 以该错误收尾。
     */
    _failPipeline(err) {
        if (this._pendingError) return;
        this._pendingError = err;
        this._releaseInflightWaiter();
        if (!this.destroyed) this.destroy(err);
    }

    _releaseInflightWaiter() {
        const waiter = this._inflightWaiter;
        if (!waiter) return;
        if (this._pendingError || this._inflightBytes < this._maxInflightBytes()) {
            this._inflightWaiter = null;
            waiter(this._pendingError || undefined);
        }
    }

    _destroy(err, callback) {
        if (this.writeStream && !this.writeStream.destroyed) {
            this.writeStream.destroy();
        }
        callback(err);
    }

    /**
     * Path truncate after the write fd is closed (fallback only).
     */
    _pathTruncateWithRetry(writeStart) {
        const pathForLog = this.filePath;
        const attempts = PATH_TRUNCATE_RETRY_DELAYS_MS.length + 1;
        const tryAt = (i) =>
            new Promise((resolve, reject) => {
                fs.truncate(pathForLog, writeStart, (truncateErr) => {
                    if (!truncateErr) {
                        logger.debug("File truncated successfully by path", {
                            path: pathForLog,
                            writeStart,
                            attempt: i + 1,
                            attempts,
                        });
                        resolve({ method: "truncate" });
                        return;
                    }
                    logger.warn(
                        "Error truncating file by path:",
                        formatWriteFsError(truncateErr, "truncate", {
                            path: pathForLog,
                            writeStart,
                            attempt: i + 1,
                            attempts,
                        })
                    );
                    if (i + 1 >= attempts) {
                        reject(truncateErr);
                        return;
                    }
                    setTimeout(() => {
                        tryAt(i + 1).then(resolve, reject);
                    }, PATH_TRUNCATE_RETRY_DELAYS_MS[i]);
                });
            });
        return tryAt(0);
    }

    /**
     * Prefer sync ftruncate on the still-open write fd (inside 'finish').
     * Returns { method: 'ftruncate', fd } or throws.
     * Caller must fall back to path truncate only after 'close'.
     */
    _ftruncateOpenFdSync(writeStart) {
        const fd = this.writeStream && this.writeStream.fd;
        if (typeof fd !== "number" || fd < 0) {
            const err = new Error("WRITE_FD_UNAVAILABLE");
            err.code = "WRITE_FD_UNAVAILABLE";
            err.path = this.filePath;
            throw err;
        }
        fs.ftruncateSync(fd, writeStart);
        logger.debug("File ftruncated successfully on write fd", {
            path: this.filePath,
            fd,
            writeStart,
        });
        return { method: "ftruncate", fd };
    }

    _getSaveFrequency() {
        const freq = this.context && this.context.options && this.context.options.saveFrequency;
        return Number.isInteger(freq) && freq > 0 ? freq : 32;
    }

    _getMinSaveIntervalMs() {
        const ms = this.context && this.context.options && this.context.options.minSaveIntervalMs;
        return Number.isFinite(ms) && ms > 0 ? ms : 0;
    }

    _getWriteStartInContext() {
        if (
            this.context.context === null ||
            this.context.context === undefined ||
            Object.keys(this.context.context).length === 0
        ) {
            logger.debug("No writeStart in context, start from 0");
            return 0;
        }
        let writeStart = this.context.context['writeStart'];
        if (!Number.isInteger(writeStart)) {
            writeStart = 0;
        }
        logger.debug("Resuming write from position:", writeStart);
        return writeStart;
    }

    _write(chunk, encoding, callback) {
        if (this._pendingError) {
            callback(this._pendingError);
            return;
        }
        if (this._needsWriteAheadSave(chunk.length)) {
            this._writeAheadSave()
                .then(() => this._writeChunk(chunk, encoding, callback))
                .catch((err) => callback(err));
            return;
        }
        this._writeChunk(chunk, encoding, callback);
    }

    /**
     * 把 chunk 交给底层 fs.WriteStream 后立即 ack（在途字节未超上限时），
     * 不再让 Unsealer 等待这次 pwrite 的线程池往返；OS 对增长中文件的写入
     * 节流停顿由 fs.WriteStream 的队列吸收。账本提交 / checkpoint 落盘仍在
     * 真实写回调里按序进行（fs.WriteStream 保证回调顺序）。
     */
    _writeChunk(chunk, encoding, callback) {
        const len = chunk.length;
        // 下一次写入的起点：供写前存档判断，必须在入队时前移
        this._writePos += len;
        this._inflightBytes += len;
        this.writeStream.write(chunk, encoding, (err) => {
            this._inflightBytes -= len;
            if (err) {
                this._failPipeline(err);
                return;
            }
            // 账本提交与 checkpoint 快照是同步完成的，只有落盘是异步；
            // 在途配额在提交后立即释放，不等落盘
            let saved;
            try {
                saved = this._onPlaintextWritten(len);
            } catch (error) {
                this._failPipeline(error);
                return;
            }
            this._releaseInflightWaiter();
            saved.catch((error) => this._failPipeline(error));
        });
        if (this._inflightBytes < this._maxInflightBytes()) {
            callback();
        } else {
            this._inflightWaiter = callback;
        }
    }

    /**
     * 是否需要写前存档：仅 inplace（读写同一文件）时启用。
     * 判据：本次写入的终点越过了最后一份已落盘存档的 readStart——
     * 该位置之后的磁盘密文没有任何落盘存档兜底，被明文覆盖后
     * SIGKILL 就无法恢复。双文件场景密文文件不会被写，直接跳过。
     */
    _needsWriteAheadSave(length) {
        if (!this.context || !this.context.runtime || !this._isInplace()) {
            return false;
        }
        return this._writePos + length > this._savedReadStart;
    }

    /**
     * 写前存档：把当前内存账本（含本次写入所属块的密文）快照落盘。
     * 完成后 savedReadStart 前移至消费前沿——由于块的密文消费总是先于
     * 其明文到达写端，本次写入必然被新快照覆盖。
     */
    _writeAheadSave() {
        this._syncContextCheckpoint();
        const ctx = this.context.context || {};
        const target = ctx.readStart || 0;
        this._unsavedItemCount = 0;
        this._lastSaveAt = Date.now();
        logger.debug("Write-ahead checkpoint before write at:", this._writePos,
                     " new covered readStart:", target);
        return Promise.resolve(this.context.saveContext()).then(() => {
            if (target > this._savedReadStart) {
                this._savedReadStart = target;
            }
        });
    }

    _onPlaintextWritten(writtenBytes){
        if(!this.context || !this.context.runtime){
            return Promise.resolve();
        }

        let remain = writtenBytes;
        const runtime = this.context.runtime;
        const blocks = runtime.pendingBlocks || [];

        let hasCommittedBlock = false;
        let committedItems = 0;

        logger.debug("On plaintext written:", writtenBytes, " bytes. Current runtime:", runtime);
        while(remain > 0 && blocks.length > 0){
            logger.debug("Remaining to commit:", remain, " bytes. Current block:", blocks[0]);
            const block = blocks[0];
            const canConsume = Math.min(remain, block.remainingPlain);
            block.remainingPlain -= canConsume;
            remain -= canConsume;

            if(block.remainingPlain === 0){
                // Block fully committed
                runtime.rawCommitted += block.rawSize;
                runtime.plainCommitted += block.plainSize;
                blocks.shift();
                hasCommittedBlock = true;
                committedItems += 1;
            }
        }
        logger.debug("After committing, remaining to commit:", remain, " bytes. Updated runtime:", runtime);
        if(!hasCommittedBlock){
            logger.debug("No full block committed yet.");
            return Promise.resolve();
        }
        if(this.context.context){
            this._syncContextCheckpoint();
            if (committedItems > 0) {
                this.context.context['readItemCount'] =
                    (this.context.context['readItemCount'] || 0) + committedItems;
            }
            logger.debug("After writing, updated readStart to:", this.context.context['readStart'],
                         " writeStart to:", this.context.context['writeStart'],
                         " readItemCount to:", this.context.context['readItemCount']);

            this._unsavedItemCount += committedItems;
            const saveFrequency = this._getSaveFrequency();
            if (this._unsavedItemCount < saveFrequency) {
                logger.debug("Deferring saveContext; unsaved items:", this._unsavedItemCount,
                             " frequency:", saveFrequency);
                return Promise.resolve();
            }
            // 时间下限（默认 0 = 关闭）：Windows 上 open/write/close/rename 一轮加
            // 杀毒软件扫描可达毫秒级，宿主可按需拉长 checkpoint 间隔
            const minInterval = this._getMinSaveIntervalMs();
            const now = Date.now();
            if (minInterval > 0 && now - this._lastSaveAt < minInterval) {
                logger.debug("Deferring saveContext; last save", now - this._lastSaveAt,
                             "ms ago, minSaveIntervalMs:", minInterval);
                return Promise.resolve();
            }
            this._unsavedItemCount = 0;
            this._lastSaveAt = now;
            const target = this.context.context['readStart'] || 0;
            return Promise.resolve(this.context.saveContext()).then(() => {
                if (target > this._savedReadStart) {
                    this._savedReadStart = target;
                }
            });
        }
        return Promise.resolve();
    }

    /**
     * 把可恢复状态写入 context（内存），保证快照自洽：
     *   readStart  = 消费前沿之后磁盘保证未被明文覆盖的位置
     *   data       = [rawCommitted, readStart) 区间的原始密文（resume 时回放）
     *   writeStart = 已完整落盘的明文字节数
     * inplace（明文写回密文同一文件）场景下，pending 块的密文区间可能已被
     * 明文覆盖，因此必须把这些密文随 checkpoint 一起持久化，而不能指望
     * resume 时从文件重读。
     * 双文件场景密文文件完好，checkpoint 只记 readStart = rawCommitted、
     * data 为空，resume 时直接从文件重读 pending 区间——这样写完成解耦后
     * 在途 item 再多，.progress 体积也不会随之膨胀。
     */
    _syncContextCheckpoint() {
        const ctx = this.context && this.context.context;
        const runtime = this.context && this.context.runtime;
        if (!ctx || !runtime) return;

        if (!this._isInplace()) {
            ctx['readStart'] = runtime.rawCommitted;
            ctx['writeStart'] = runtime.plainCommitted;
            ctx['data'] = Buffer.alloc(0);
            return;
        }

        const blocks = runtime.pendingBlocks || [];
        const parts = [];
        let pendingRawLen = 0;
        for (const b of blocks) {
            if (b.raw && b.raw.length) {
                parts.push(b.raw);
                pendingRawLen += b.raw.length;
            }
        }
        // 消费前沿：unsealer 已消费（可能已被明文覆盖）的密文末尾
        const frontier = runtime.rawCommitted + pendingRawLen;
        let readStart = frontier;

        // 上次 checkpoint 回放数据中还未被本次消费覆盖的尾段（含 unsealer
        // remaining、管道缓冲、未回放部分）同样源自可能被覆盖的磁盘区域，
        // 需要一并保留
        const loadedData = runtime.loadedData;
        const loadedStart = runtime.loadedDataStart || 0;
        const loadedEnd = loadedStart + (loadedData ? loadedData.length : 0);
        if (loadedData && loadedEnd > frontier) {
            parts.push(loadedData.slice(frontier - loadedStart));
            readStart = loadedEnd;
        }

        ctx['readStart'] = readStart;
        ctx['writeStart'] = runtime.plainCommitted;
        ctx['data'] = parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
    }

    _final(callback) {
        if (this._finalizeStarted) {
            logger.warn("RecoverableWriteStream._final re-entered; ignoring", {
                path: this.filePath,
            });
            callback();
            return;
        }
        this._finalizeStarted = true;

        const saveAndFinish = () => {
            if (this.context && typeof this.context.saveContext === 'function') {
                this._unsavedItemCount = 0;
                Promise.resolve(this.context.saveContext())
                    .then(() => callback())
                    .catch((err) => callback(err));
            } else {
                callback();
            }
        };

        this.writeStream.once('finish', () => {
            const ctx = this.context && this.context.context;
            this._syncContextCheckpoint();

            // 仅当解密真正完成时才截断：完成时去掉残留尾巴（inplace 场景
            // 下即密文尾段 + 块信息 + header）。暂停/中断时绝不能截断，
            // 否则 inplace 场景会毁掉尚未消费的密文与文件尾部 header。
            if (!ctx || ctx['decryptCompleted'] !== true) {
                logger.debug("Decrypt not completed; skip truncate at checkpoint", {
                    path: this.filePath,
                    writeStart: ctx && ctx['writeStart'],
                });
                saveAndFinish();
                return;
            }

            const writeStart = (ctx && ctx['writeStart']) || 0;
            const fdBefore = this.writeStream && this.writeStream.fd;
            logger.debug("Finalizing decrypt output truncate", {
                path: this.filePath,
                writeStart,
                fd: fdBefore,
            });

            try {
                this._ftruncateOpenFdSync(writeStart);
                saveAndFinish();
            } catch (ftruncateErr) {
                logger.warn(
                    "Error ftruncate on open write fd; will path-truncate after close:",
                    formatWriteFsError(ftruncateErr, "ftruncate", {
                        path: this.filePath,
                        writeStart,
                        fd: fdBefore,
                        decryptCompleted: true,
                    })
                );
                // autoClose will close after this finish handler returns; truncate by path then.
                const afterClose = () => {
                    this._pathTruncateWithRetry(writeStart)
                        .then(() => saveAndFinish())
                        .catch((truncateErr) => {
                            logger.warn(
                                "Error truncating file in _final (path fallback):",
                                formatWriteFsError(truncateErr, "truncate", {
                                    path: this.filePath,
                                    writeStart,
                                    fd: fdBefore,
                                    decryptCompleted: true,
                                })
                            );
                            callback(truncateErr);
                        });
                };
                if (this.writeStream.closed || this.writeStream.destroyed) {
                    afterClose();
                } else {
                    this.writeStream.once('close', afterClose);
                }
            }
        });
        this.writeStream.end();
        logger.debug("Finalizing write stream", { path: this.filePath });
    }
}
