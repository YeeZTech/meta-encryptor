import {WriteStream} from 'fs';

const {Readable, Writable} = require('stream');
const {SealedFileStream} = require('./SealedFileStream.js');
const {HeaderSize} = require('./limits.js');
const fs = require('fs');
import log from 'loglevel';

const logger = log.getLogger("meta-encryptor/Recoverable");

export class RecoverableReadStream extends Readable {
    constructor(filePath, context, options) {
        super(options);
        this.options = options;
        this.context = context;
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
                this.push(null); // 表示流结束
            }
            // 读完后显式销毁底层 SealedFileStream，关闭 FileHandle
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
        // 确保在流销毁时关闭底层 SealedFileStream 对应的 FileHandle
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
            // 文件存在，获取文件大小
            this.fileSize = fs.statSync(filePath).size;
            if (writeStart > 0) {
                // 文件存在且有写入点 - 使用 'r+' 模式，保留现有内容
                streamOptions = {
                    flags: 'r+',
                    start: writeStart
                };
                logger.debug(`Opening file ${filePath} for resuming write at position: ${writeStart}`);
            } else {
                // 新文件或从头开始 - 也用使用 'r+' 模式，否则会自动截断start后面的内容
                streamOptions = {
                    flags: 'r+',
                    start: 0
                };
                logger.debug(`File is empty. Creating new file ${filePath} for writing`);
            }
        } else {
            // 文件不存在，创建新文件
            // 先创建空文件
            fs.writeFileSync(filePath, '');
            this.fileSize = 0;

            streamOptions = {
                flags: 'r+',
                start: 0
            };
            logger.debug(`File not exist.Created new file ${filePath} for writing`);
        }
        this.writeStream = new WriteStream(filePath, streamOptions);

        this.writeStream.on('error', (err) => {
            this.emit('error', err);
        });
        this.writeStream.on('close', () => {
        });
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
        this.writeStream.write(chunk, encoding, (err) => {
            if (err) {
                callback(err);
            } else {
                
                //logger.debug("Updated writeStart in context to:", this.context.context['writeStart']);
                this._onPlaintextWritten(chunk.length).then(() => {
                    callback();
                }).catch((error) => {
                    callback(error);
                });
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
        let committedRawBytes = 0;

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
                committedRawBytes += block.rawSize;
                blocks.shift();
                hasCommittedBlock = true;
            }
        }
        logger.debug("After committing, remaining to commit:", remain, " bytes. Updated runtime:", runtime);
        if(!hasCommittedBlock){
            logger.debug("No full block committed yet.");
            return Promise.resolve();
        }
        if(this.context.context){
            const buf = this.context.context['data'];
            if(Buffer.isBuffer(buf) && buf.length > 0 &&
               committedRawBytes > 0){
                if(committedRawBytes >= buf.length){
                    // All data committed
                    this.context.context['data'] = Buffer.alloc(0);
                }else{
                    // Partial data committed
                    this.context.context['data'] = buf.subarray(committedRawBytes);
                }
            }
            this.context.context['readStart'] = runtime.rawCommitted;
            this.context.context['writeStart'] = runtime.plainCommitted;
            logger.debug("After writing, updated readStart to:", this.context.context['readStart'],
                         " writeStart to:", this.context.context['writeStart'],
                         " data length to:", this.context.context['data'] ? this.context.context['data'].length : 0);
            //
            this.context.saveContext();
        }
        return Promise.resolve();
    }

    _final(callback) {
        this.writeStream.on('finish', () => {
            const readStart = this.context.context['readStart'] || 0;
            const writeStart = this.context.context['writeStart'] || 0;
            const length = this.context.context.data ? this.context.context.data.length : 0;

            // 检查是否到达文件末尾
            if (readStart + length >= this.fileSize) {
                // 到达文件末尾，执行截断
                fs.truncate(this.filePath, writeStart, (truncateErr) => {
                    if (truncateErr) {
                        logger.warn("Error truncating file:", truncateErr);
                        callback(truncateErr);
                    } else {
                        logger.debug("File truncated successfully to length:", writeStart);
                        callback();
                    }
                });
            } else {
                // 未到达文件末尾，不执行截断
                logger.debug("Not truncating file as not at the end. readStart + length:", readStart + length, ", fileSize:", this.fileSize);
                callback();
            }
        });
        this.writeStream.end();
        logger.debug("Finalizing write stream");
    }
}
