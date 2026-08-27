import {WriteStream} from 'fs';
import {Readable, Writable} from 'stream';
import { SealedFileStream } from './SealedFileStream.js';
import { HeaderSize } from '../common/limits.js';
import fs from 'fs';
import path from 'path';
import log from 'loglevel';

const logger = log.getLogger("meta-encryptor/Recoverable");

export class RecoverableReadStream extends Readable {
    constructor(filePath, context, options) {
        super(options);
        this.options = options;
        this.context = context;
        // 记录读端文件路径；写端据此识别 inplace（读写同一文件）并启用写前存档
        if (context && context.runtime) {
            context.runtime.readFilePath = path.resolve(filePath);
        }
        this.inputStream = new SealedFileStream(filePath, {
            start: this._getReadStartInContext()
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

export class RecoverableWriteStream extends Writable {
    constructor(filePath, context, options) {
        super(options);
        this.options = options;
        this.context = context;
        this.filePath = filePath;

        const writeStart = this._getWriteStartInContext();
        const fileExists = fs.existsSync(filePath);
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
        this.writeStream = new WriteStream(filePath, streamOptions);
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
            this.emit('error', err);
        });
        this.writeStream.on('close', () => {
        });
    }

    _getSaveFrequency() {
        const freq = this.context && this.context.options && this.context.options.saveFrequency;
        return Number.isInteger(freq) && freq > 0 ? freq : 32;
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
        if (this._needsWriteAheadSave(chunk.length)) {
            this._writeAheadSave()
                .then(() => this._writeChunk(chunk, encoding, callback))
                .catch((err) => callback(err));
            return;
        }
        this._writeChunk(chunk, encoding, callback);
    }

    _writeChunk(chunk, encoding, callback) {
        this.writeStream.write(chunk, encoding, (err) => {
            if (err) {
                callback(err);
            } else {
                this._writePos += chunk.length;
                this._onPlaintextWritten(chunk.length).then(() => {
                    callback();
                }).catch((error) => {
                    callback(error);
                });
            }
        });
    }

    /**
     * 是否需要写前存档：仅 inplace（读写同一文件）时启用。
     * 判据：本次写入的终点越过了最后一份已落盘存档的 readStart——
     * 该位置之后的磁盘密文没有任何落盘存档兜底，被明文覆盖后
     * SIGKILL 就无法恢复。双文件场景密文文件不会被写，直接跳过。
     */
    _needsWriteAheadSave(length) {
        const runtime = this.context && this.context.runtime;
        if (!runtime || runtime.readFilePath !== this._resolvedPath) {
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
            this._unsavedItemCount = 0;
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
     */
    _syncContextCheckpoint() {
        const ctx = this.context && this.context.context;
        const runtime = this.context && this.context.runtime;
        if (!ctx || !runtime) return;

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
        this.writeStream.on('finish', () => {
            const ctx = this.context && this.context.context;
            this._syncContextCheckpoint();

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

            // 仅当解密真正完成时才截断：完成时去掉残留尾巴（inplace 场景
            // 下即密文尾段 + 块信息 + header）。暂停/中断时绝不能截断，
            // 否则 inplace 场景会毁掉尚未消费的密文与文件尾部 header。
            if (!ctx || ctx['decryptCompleted'] !== true) {
                logger.debug("Decrypt not completed; skip truncate at checkpoint");
                saveAndFinish();
                return;
            }

            const writeStart = (ctx && ctx['writeStart']) || 0;
            fs.truncate(this.filePath, writeStart, (truncateErr) => {
                if (truncateErr) {
                    logger.warn("Error truncating file:", truncateErr);
                    callback(truncateErr);
                    return;
                }
                logger.debug("File truncated successfully to length:", writeStart);
                saveAndFinish();
            });
        });
        this.writeStream.end();
        logger.debug("Finalizing write stream");
    }
}
