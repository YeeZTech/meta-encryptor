import log from 'loglevel';

import fs from 'fs';
import { promisify } from 'util';

import { MetaEncryptorError } from '../common/errors.js';

const open = promisify(fs.open);
const close = promisify(fs.close);
const fsync = promisify(fs.fsync);
const rename = promisify(fs.rename);
const logger = log.getLogger("meta-encryptor/PipelineContext");

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
            pendingBlocks: [] //[{rawSize, plainSize, remainingPlain}]
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

    async _writeContextAtomic() {
        const fileBuffer = this._buildPayload();
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

        await rename(tmpPath, this.filePath);
    }

    async _flushAll() {
        while (this._saveDirty) {
            this._saveDirty = false;
            try {
                await this._writeContextAtomic();
            } catch (error) {
                logger.error('PipelineContextInFile::saveContext error:', error.message);
                throw error;
            }
        }
    }

    saveContext() {
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

            const readStart = this.context.readStart || 0;
            const writeStart = this.context.writeStart || 0;
            this.runtime.rawCommitted = readStart;
            this.runtime.plainCommitted = writeStart;
            this.runtime.pendingBlocks = [];
        } catch (error) {
            logger.error('PipelineContextInFile::loadContext error:', error.message);
            this.context = {};
            throw error;
        }
    }
}
