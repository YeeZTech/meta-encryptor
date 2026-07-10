import log from 'loglevel';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { MetaEncryptorError } from '../common/errors.js';

const logger = log.getLogger('meta-encryptor/PipelineContext');
const CONTEXT_VERSION = 2;
const MAX_METADATA_SIZE = 16 * 1024 * 1024;

function toBinaryChunk(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
}

function resetRuntime(runtime) {
    runtime.rawCommitted = 0;
    runtime.plainCommitted = 0;
    runtime.pendingBlocks = [];
    runtime.unattributedPlain = 0;
    runtime.inputComplete = false;
    runtime.skipSealedInput = false;
}

function assertOffset(value, key) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
            detail: { field: key, value }
        });
    }
}

async function readExactly(handle, buffer, offset, length, position) {
    let total = 0;
    while (total < length) {
        const { bytesRead } = await handle.read(
            buffer,
            offset + total,
            length - total,
            position + total
        );
        if (bytesRead === 0) {
            throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
                detail: { expected: length, actual: total }
            });
        }
        total += bytesRead;
    }
}

async function writeExactly(handle, buffer, position = 0) {
    let total = 0;
    while (total < buffer.length) {
        const { bytesWritten } = await handle.write(
            buffer,
            total,
            buffer.length - total,
            position + total
        );
        if (bytesWritten === 0) {
            throw new MetaEncryptorError('ERR_PIPELINE_CONTEXT_SAVE');
        }
        total += bytesWritten;
    }
}

export class PipelineContext {
    constructor(options) {
        this.context = {};
        this.options = options || {};
        this.runtime = {};
        resetRuntime(this.runtime);
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
        const meta = Object.create(null);
        let offset = 0;

        for (const [key, value] of Object.entries(this.context)) {
            const binary = toBinaryChunk(value);
            if (binary) {
                binaryChunks.push(binary);
                meta[key] = { type: 'binary', offset, length: binary.length };
                offset += binary.length;
            } else {
                meta[key] = { type: 'json', value };
            }
        }

        const metaBuffer = Buffer.from(JSON.stringify(meta));
        if (metaBuffer.length > MAX_METADATA_SIZE) {
            throw new MetaEncryptorError('ERR_PIPELINE_CONTEXT_SAVE', {
                detail: { metadataSize: metaBuffer.length }
            });
        }

        const fileBuffer = Buffer.allocUnsafe(4 + metaBuffer.length + offset);
        fileBuffer.writeUInt32BE(metaBuffer.length, 0);
        metaBuffer.copy(fileBuffer, 4);
        let currentOffset = 4 + metaBuffer.length;
        for (const chunk of binaryChunks) {
            chunk.copy(fileBuffer, currentOffset);
            currentOffset += chunk.length;
        }
        return fileBuffer;
    }

    async _writeContextAtomic() {
        const fileBuffer = this._buildPayload();
        const directory = path.dirname(path.resolve(this.filePath));
        const tmpPath = path.join(
            directory,
            `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`
        );
        let handle;

        logger.debug('PipelineContextInFile::saveContext saving to', this.filePath);
        try {
            handle = await fs.promises.open(tmpPath, 'wx', 0o600);
            await writeExactly(handle, fileBuffer);
            await handle.sync();
        } catch (error) {
            try { await fs.promises.unlink(tmpPath); } catch (_) {}
            throw error;
        } finally {
            if (handle) await handle.close();
        }

        try {
            await fs.promises.rename(tmpPath, this.filePath);
        } catch (error) {
            try { await fs.promises.unlink(tmpPath); } catch (_) {}
            throw error;
        }
    }

    async _flushAll() {
        while (this._saveDirty) {
            this._saveDirty = false;
            await this._writeContextAtomic();
        }
    }

    saveContext() {
        this._saveDirty = true;
        this._saveTail = this._saveTail.then(
            () => this._flushAll(),
            () => this._flushAll()
        );
        return this._saveTail;
    }

    async loadContext() {
        let handle;
        try {
            await this._saveTail;
            if (!fs.existsSync(this.filePath)) {
                this.context = {};
                resetRuntime(this.runtime);
                return;
            }

            handle = await fs.promises.open(this.filePath, 'r');
            const stat = await handle.stat();
            if (stat.size < 4) {
                throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID');
            }

            const metaLengthBuffer = Buffer.allocUnsafe(4);
            await readExactly(handle, metaLengthBuffer, 0, 4, 0);
            const metaLength = metaLengthBuffer.readUInt32BE(0);
            if (metaLength > MAX_METADATA_SIZE || metaLength > stat.size - 4) {
                throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
                    detail: { metadataSize: metaLength, fileSize: stat.size }
                });
            }

            const metaBuffer = Buffer.allocUnsafe(metaLength);
            await readExactly(handle, metaBuffer, 0, metaLength, 4);
            let meta;
            try {
                meta = JSON.parse(metaBuffer.toString('utf8'));
            } catch (cause) {
                throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', { cause });
            }
            if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
                throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID');
            }

            const binaryStart = 4 + metaLength;
            const binarySize = stat.size - binaryStart;
            const loaded = {};
            for (const [key, info] of Object.entries(meta)) {
                if (!info || typeof info !== 'object') {
                    throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', { detail: { field: key } });
                }
                if (info.type === 'binary') {
                    assertOffset(info.offset, `${key}.offset`);
                    assertOffset(info.length, `${key}.length`);
                    if (info.offset + info.length > binarySize) {
                        throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', { detail: { field: key } });
                    }
                    const buffer = Buffer.allocUnsafe(info.length);
                    await readExactly(handle, buffer, 0, info.length, binaryStart + info.offset);
                    loaded[key] = buffer;
                } else if (info.type === 'json' && Object.hasOwn(info, 'value')) {
                    loaded[key] = info.value;
                } else {
                    throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', { detail: { field: key } });
                }
            }

            if (loaded.checkpointVersion !== undefined && loaded.checkpointVersion !== CONTEXT_VERSION) {
                throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
                    detail: { version: loaded.checkpointVersion }
                });
            }
            assertOffset(loaded.readStart ?? 0, 'readStart');
            assertOffset(loaded.writeStart ?? 0, 'writeStart');
            if (loaded.readItemCount !== undefined) assertOffset(loaded.readItemCount, 'readItemCount');

            this.context = loaded;
            this.runtime.rawCommitted = loaded.readStart ?? 0;
            this.runtime.plainCommitted = loaded.writeStart ?? 0;
            this.runtime.pendingBlocks = [];
            this.runtime.unattributedPlain = 0;
            this.runtime.inputComplete = loaded.phase === 'replacing' || loaded.phase === 'complete';
            this.runtime.skipSealedInput = false;
        } catch (error) {
            logger.error('PipelineContextInFile::loadContext error:', error.message);
            this.context = {};
            resetRuntime(this.runtime);
            if (error instanceof MetaEncryptorError) throw error;
            throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', { cause: error });
        } finally {
            if (handle) await handle.close();
        }
    }
}

export { CONTEXT_VERSION };
