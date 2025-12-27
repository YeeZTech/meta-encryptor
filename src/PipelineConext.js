import log from 'loglevel';

const fs = require('fs');
const { promisify } = require('util');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const logger = log.getLogger("meta-encryptor/PipelineContext");

export class PipelineContext {
    constructor(options) {
        this.context = {};
        this.options = options || {};
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
        throw new Error('saveContext should be implemented');
    }

    loadContext() {
        throw new Error('loadContext should be implemented');
    }
}

export class PipelineContextInFile extends PipelineContext {
    constructor(filePath, options) {
        super(options);
        this.filePath = filePath;
    }

    async saveContext() {
        const binaryChunks = [];
        const meta = {};
        let offset = 0;

        logger.debug("Context before save:", this.context);
        logger.debug("PipelineContextInFile::saveContext saving to ", this.filePath);

        for (const [key, value] of Object.entries(this.context)) {
            if (Buffer.isBuffer(value)) {
                binaryChunks.push(value);
                meta[key] = {
                    type: 'binary',
                    offset,
                    length: value.length
                };
                offset += value.length;
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

        try {
            const fd = await promisify(fs.open)(this.filePath, 'w');
            const lengthBuffer = Buffer.alloc(4);
            lengthBuffer.writeUInt32BE(metaLength);
            await promisify(fs.write)(fd, lengthBuffer, 0, 4, 0);
            await promisify(fs.write)(fd, metaBuffer, 0, metaLength, 4);
            let currentOffset = 4 + metaLength;
            for (const chunk of binaryChunks) {
                await promisify(fs.write)(fd, chunk, 0, chunk.length, currentOffset);
                currentOffset += chunk.length;
            }
            await promisify(fs.close)(fd);
        } catch (error) {
            console.error('PipelineContextInFile::saveContext error:', error.message);
            throw error;
        }
    }

    async loadContext() {
        try {
            if (!fs.existsSync(this.filePath)) {
                this.context = {};
                this.runtime.rawCommitted = 0;
                this.runtime.plainCommitted = 0;
                this.runtime.pendingBlocks = [];
                return;
            }

            const fd = await promisify(fs.open)(this.filePath, 'r');
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
                        throw new Error('PipelineContextInFile::loadContext invalid length');
                    }
                    this.context[key] = buffer;
                } else {
                    this.context[key] = info.value;
                }
            }

            await promisify(fs.close)(fd);

            const readStart = this.context.readStart || 0;
            const writeStart = this.context.writeStart || 0;
            this.runtime.rawCommitted = readStart;
            this.runtime.plainCommitted = writeStart;
            this.runtime.pendingBlocks = [];
        } catch (error) {
            console.error('PipelineContextInFile::loadContext error:', error.message);
            // 当上下文文件损坏或内容不完整时，视为无上下文，避免直接中断流程
            this.context = {};
            throw error;
        }
    }
}
