import { WriteStream } from 'fs';

const {
    Readable, Writable
  } = require('stream');
const {SealedFileStream} = require('./SealedFileStream.js');
const { HeaderSize } = require('./limits.js');
const fs = require("fs");

export class RecoverableReadStream extends Readable{
    constructor(filePath, context, options){
        super(options)
        this.options = options;
        this.context = context;
        this.inputStream = new SealedFileStream(filePath, {start:this._getReadStartInContext()})
        this.state = "header"
        this.headerRead = 0

        this.inputStream.on('error', (err) => {
            this.emit('error', err);
        });
        this.inputStream.on('end', () => {
            if (this.state === 'remaining') {
                this.push(null); // 表示流结束
            }
        });
    }

    _getReadStartInContext(){
        if(this.context.context === null || this.context.context === undefined || 
            Object.keys(this.context.context).length === 0){
            return 0
        }
        return this.context.context["readStart"]
    }
    _getDataInContext(){
        if(this.context.context === null || this.context.context === undefined ||
            Object.keys(this.context.context).length === 0){
            return Buffer.alloc(0);
        }
        return this.context.context["data"]
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
                const contextData = this._getDataInContext();
                if (contextData.length > 0) {
                    const chunkSize = Math.min(contextData.length, size);
                    const chunk = contextData.slice(0, chunkSize);
                    this.context.context["data"] = contextData.slice(chunkSize);
                    this.push(chunk);
                    if (this.context.context["data"].length === 0) {
                        this.state = 'remaining';
                    }
                } else {
                    this.state = 'remaining';
                    this._read(size);
                }
                break;
            case 'remaining':
                const remainingChunk = this.inputStream.read(size);
                if (remainingChunk) {
                    this.context.context["readStart"] += remainingChunk.length;
                    this.context.context["data"] = remainingChunk
                    this.context.saveContext();
                    this.push(remainingChunk);
                } else {
                    if (this.inputStream.readableEnded) {
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

export class RecoverableWriteStream extends Writable{
    constructor(filePath, context, options){
        super(options)
        this.options = options;
        this.context = context;
        this.filePath = filePath;
        this.writeStream = new WriteStream(filePath, {start:this._getWriteStartInContext()})
        this.writeStream.on('error', (err) => {
            this.emit('error', err); 
        });
        this.writeStream.on('close', () => {
            fs.truncate(this.filePath, this.context.context["writeStart"],(truncateErr) => {
                if (truncateErr) {
                    this.emit('error', truncateErr);
                } else {}
            });
        });
    }

    _getWriteStartInContext(){
        if(this.context.context === null || this.context.context === undefined || 
            Object.keys(this.context.context).length === 0){
            return 0
        }
        let writeStart = this.context.context["writeStart"];
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
                this.context.context["writeStart"] = this._getWriteStartInContext() +  chunk.length;
                callback();
            }
        });
    }

    _final(callback) {
        
        this.writeStream.on("finish", () => {
            callback();
        });
        this.writeStream.end();
    }
}