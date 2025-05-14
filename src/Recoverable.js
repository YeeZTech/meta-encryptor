import {WriteStream} from 'fs';

const {Readable, Writable} = require('stream');
const {SealedFileStream} = require('./SealedFileStream.js');
const {HeaderSize} = require('./limits.js');
const fs = require('fs');

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
        });
    }

    _getReadStartInContext() {
        if (
            this.context.context === null ||
            this.context.context === undefined ||
            this.context.context.readStart === undefined ||
            Object.keys(this.context.context).length === 0
        ) {
            return 0;
        }

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
            return Buffer.alloc(0);
        }
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
                    //this.context.context['data'] = remainingChunk;
                    //this.context.saveContext();
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
                break;
        }
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
                console.log(`Opening file for resuming write at position: ${writeStart}`);
            } else {
                // 新文件或从头开始 - 也用使用 'r+' 模式，否则会自动截断start后面的内容
                streamOptions = {
                    flags: 'r+',
                    start: 0
                };
                console.log(`Creating new file for writing`);
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
            console.log(`Created new file for writing`);
        }
        this.writeStream = new WriteStream(filePath, streamOptions);

        this.writeStream.on('error', (err) => {
            this.emit('error', err);
        });
        this.writeStream.on('close', () => {
            // fs.truncate(this.filePath, this.context.context['writeStart'], (truncateErr) => {
            //     if (truncateErr) {
            //         this.emit('error', truncateErr);
            //     } else {
            //     }
            // });
        });
    }

    _getWriteStartInContext() {
        if (
            this.context.context === null ||
            this.context.context === undefined ||
            Object.keys(this.context.context).length === 0
        ) {
            return 0;
        }
        let writeStart = this.context.context['writeStart'];
        if (!Number.isInteger(writeStart)) {
            writeStart = 0;
        }

        return writeStart;
    }

    _write(chunk, encoding, callback) {
        this.writeStream.write(chunk, encoding, (err) => {
            if (err) {
                callback(err);
            } else {
                //!We only update, don't save context
                this.context.context['writeStart'] = this._getWriteStartInContext() + chunk.length;
                callback();
            }
        });
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
                        callback(truncateErr);
                    } else {
                        callback();
                    }
                });
            } else {
                // 未到达文件末尾，不执行截断
                callback();
            }
        });
        this.writeStream.end();
    }
}
