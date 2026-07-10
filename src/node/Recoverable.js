import {WriteStream} from 'fs';
import {Readable, Writable} from 'stream';
import { SealedFileStream } from './SealedFileStream.js';
import { HeaderSize } from '../common/limits.js';
import { MetaEncryptorError } from '../common/errors.js';
import fs from 'fs';
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
        this.inputEnded = false;
        this.pushedEof = false;
        this.waitingReadable = false;

        this.inputStream.on('error', (err) => {
            this.emit('error', err);
        });
        this.inputStream.on('end', () => {
            this.inputEnded = true;
            if (this.state === 'header') {
                // input ended before a full header could be read — corrupt file
                this.emit('error', new MetaEncryptorError('ERR_UNEXPECTED_EOF'));
            } else if (this.state === 'remaining') {
                this._pushEof();
            }
            // 'contextData' needs no action: once the context data is drained,
            // _read switches to 'remaining' and sees inputEnded.
            if (this.inputStream && typeof this.inputStream.destroy === 'function') {
                this.inputStream.destroy();
            }
        });
    }

    _pushEof() {
        if (this.pushedEof) return;
        this.pushedEof = true;
        this.push(null);
    }

    _waitReadable(size) {
        if (this.waitingReadable) return;
        this.waitingReadable = true;
        this.inputStream.once('readable', () => {
            this.waitingReadable = false;
            this._read(size);
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
                } else if (this.inputEnded || this.inputStream.readableEnded) {
                    this.emit('error', new MetaEncryptorError('ERR_UNEXPECTED_EOF'));
                } else {
                    this._waitReadable(size);
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
                    if (this.inputEnded || this.inputStream.readableEnded) {
                        this._pushEof();
                    } else {
                        this._waitReadable(size);
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
        this._finalSettle = null;

        this.writeStream.on('error', (err) => {
            if (this._finalSettle) {
                this._finalSettle(err);
            } else if (!this.destroyed) {
                this.destroy(err);
            }
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
            this.context.context['readStart'] = runtime.rawCommitted;
            this.context.context['writeStart'] = runtime.plainCommitted;
            if (committedItems > 0) {
                this.context.context['readItemCount'] =
                    (this.context.context['readItemCount'] || 0) + committedItems;
            }
            // Checkpoint only fully committed progress; discard in-flight cipher tail.
            this.context.context['data'] = Buffer.alloc(0);
            logger.debug("After writing, updated readStart to:", this.context.context['readStart'],
                         " writeStart to:", this.context.context['writeStart'],
                         " readItemCount to:", this.context.context['readItemCount']);
            return this.context.saveContext();
        }
        return Promise.resolve();
    }

    _final(callback) {
        const inner = this.writeStream;
        let settled = false;
        let finalizing = false;

        const cleanup = () => {
            if (!inner) return;
            inner.removeListener('finish', finalize);
            inner.removeListener('close', onInnerClose);
            if (this._finalSettle === settle) {
                this._finalSettle = null;
            }
        };

        const settle = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(err);
        };

        const finalize = async () => {
            if (settled || finalizing) return;
            finalizing = true;

            const ctx = this.context && this.context.context;
            const runtime = this.context && this.context.runtime;
            const readStart = runtime?.rawCommitted ?? ctx?.readStart ?? 0;
            const writeStart = runtime?.plainCommitted ?? ctx?.writeStart ?? 0;

            try {
                // Always remove stale output beyond the last fully committed item.
                await fs.promises.truncate(this.filePath, writeStart);

                if (ctx) {
                    ctx['readStart'] = readStart;
                    ctx['writeStart'] = writeStart;
                    ctx['data'] = Buffer.alloc(0);
                }

                if (this.context && typeof this.context.saveContext === 'function') {
                    await this.context.saveContext();
                }

                logger.debug("File truncated successfully to length:", writeStart);
                settle();
            } catch (err) {
                logger.warn("Error finalizing recoverable output:", err);
                settle(err);
            }
        };

        const onInnerClose = () => {
            if (!inner.writableFinished) {
                settle(new Error('RecoverableWriteStream: inner stream closed before finalize'));
            }
        };

        // The constructor's single inner-error handler routes errors here
        // while _final is active, avoiding duplicate outer error emissions.
        this._finalSettle = settle;

        // The inner fs stream may already be finished or destroyed (pause /
        // cleanup paths call end()/destroy() directly). Waiting for a 'finish'
        // that will never fire would leave _final's callback pending forever,
        // so the outer stream would never emit 'finish'.
        if (inner.writableFinished) {
            void finalize();
        } else if (inner.destroyed) {
            settle(new Error('RecoverableWriteStream: inner stream destroyed before finalize'));
        } else {
            inner.once('finish', finalize);
            inner.once('close', onInnerClose);
            try {
                inner.end();
            } catch (err) {
                settle(err);
            }
        }
        logger.debug("Finalizing write stream");
    }

    _destroy(err, callback) {
        if (this.writeStream && !this.writeStream.destroyed) {
            this.writeStream.destroy();
        }
        callback(err);
    }
}
