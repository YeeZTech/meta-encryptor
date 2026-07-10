import { Readable, Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import log from 'loglevel';

import { SealedFileStream } from './SealedFileStream.js';
import { HeaderSize } from '../common/limits.js';
import { MetaEncryptorError } from '../common/errors.js';
import { CONTEXT_VERSION } from './PipelineConext.js';

const logger = log.getLogger('meta-encryptor/Recoverable');

function ensureRuntime(context) {
    if (!context.runtime) context.runtime = {};
    const runtime = context.runtime;
    if (!Number.isSafeInteger(runtime.rawCommitted) || runtime.rawCommitted < 0) runtime.rawCommitted = 0;
    if (!Number.isSafeInteger(runtime.plainCommitted) || runtime.plainCommitted < 0) runtime.plainCommitted = 0;
    if (!Array.isArray(runtime.pendingBlocks)) runtime.pendingBlocks = [];
    if (!Number.isSafeInteger(runtime.unattributedPlain) || runtime.unattributedPlain < 0) runtime.unattributedPlain = 0;
    if (typeof runtime.inputComplete !== 'boolean') runtime.inputComplete = false;
    if (typeof runtime.skipSealedInput !== 'boolean') runtime.skipSealedInput = false;
    return runtime;
}

function resetForLegacyMigration(context) {
    const old = context.context || {};
    const hadProgress = (old.readStart ?? 0) > 0 || (old.writeStart ?? 0) > 0 ||
        (old.data && old.data.length > 0);
    if (!hadProgress) return;

    // A legacy checkpoint does not carry a trustworthy absolute item count,
    // source fingerprint, or rolling hash. Restarting from item zero is the
    // only way to migrate it without weakening truncation/integrity checks.
    context.context = {
        checkpointVersion: CONTEXT_VERSION,
        migratedFromLegacy: true,
        readStart: 0,
        writeStart: 0,
        readItemCount: 0,
        data: Buffer.alloc(0),
        phase: 'processing'
    };
    const runtime = ensureRuntime(context);
    runtime.rawCommitted = 0;
    runtime.plainCommitted = 0;
    runtime.pendingBlocks = [];
    runtime.unattributedPlain = 0;
    runtime.inputComplete = false;
}

function sameFileIdentity(sourcePath, targetPath) {
    if (!sourcePath) return false;
    if (path.resolve(sourcePath) === path.resolve(targetPath)) return true;
    try {
        const source = fs.statSync(sourcePath);
        const target = fs.statSync(targetPath);
        return source.dev === target.dev && source.ino === target.ino;
    } catch (_) {
        return false;
    }
}

function stagingPathFor(targetPath) {
    const resolved = path.resolve(targetPath);
    return path.join(
        path.dirname(resolved),
        `.${path.basename(resolved)}.meta-encryptor.${crypto.randomBytes(12).toString('hex')}.staging`
    );
}

function invalidCheckpoint(field, value, cause) {
    return new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
        detail: { field, value },
        cause
    });
}

function resolveCheckpointPath(value, field) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
        throw invalidCheckpoint(field, value);
    }
    try {
        return path.resolve(value);
    } catch (cause) {
        throw invalidCheckpoint(field, value, cause);
    }
}

function sameResolvedPath(left, right) {
    return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function validateStagingPath(targetPath, candidate) {
    const target = path.resolve(targetPath);
    const staging = resolveCheckpointPath(candidate, 'output.stagingPath');
    const targetDirectory = path.dirname(target);
    if (!sameResolvedPath(path.dirname(staging), targetDirectory)) {
        throw invalidCheckpoint('output.stagingPath', candidate);
    }

    const prefix = `.${path.basename(target)}.meta-encryptor.`;
    const suffix = '.staging';
    const name = path.basename(staging);
    const token = name.startsWith(prefix) && name.endsWith(suffix)
        ? name.slice(prefix.length, -suffix.length)
        : '';
    if (!/^[0-9a-f]{24}$/i.test(token)) {
        throw invalidCheckpoint('output.stagingPath', candidate);
    }
    return staging;
}

function assertRegularPrivateFile(stat, field, filePath) {
    if (!stat.isFile() || stat.nlink !== 1) {
        throw invalidCheckpoint(field, filePath);
    }
}

function sameFileStat(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}

function assertPathIdentity(filePath, expectedStat, field = 'output.stagingPath') {
    let current;
    try {
        current = fs.lstatSync(filePath);
    } catch (cause) {
        throw invalidCheckpoint(field, filePath, cause);
    }
    assertRegularPrivateFile(current, field, filePath);
    if (!sameFileStat(current, expectedStat)) {
        throw invalidCheckpoint(field, filePath);
    }
}

function openExistingPrivateFile(filePath, flags, field = 'output.stagingPath') {
    let before;
    try {
        before = fs.lstatSync(filePath);
    } catch (cause) {
        if (cause?.code === 'ENOENT') throw cause;
        throw invalidCheckpoint(field, filePath, cause);
    }
    assertRegularPrivateFile(before, field, filePath);

    let fd;
    try {
        fd = fs.openSync(filePath, flags | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(fd);
        assertRegularPrivateFile(opened, field, filePath);
        if (!sameFileStat(before, opened)) throw invalidCheckpoint(field, filePath);
        assertPathIdentity(filePath, opened, field);
        return { fd, stat: opened };
    } catch (cause) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        if (cause instanceof MetaEncryptorError) throw cause;
        throw invalidCheckpoint(field, filePath, cause);
    }
}

function createPrivateStagingFile(filePath) {
    let fd;
    try {
        const flags = fs.constants.O_CREAT | fs.constants.O_EXCL |
            fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0);
        fd = fs.openSync(filePath, flags, 0o600);
        const opened = fs.fstatSync(fd);
        assertRegularPrivateFile(opened, 'output.stagingPath', filePath);
        assertPathIdentity(filePath, opened);
        return { fd, stat: opened };
    } catch (cause) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        throw cause;
    }
}

function openStagingForWrite(targetPath, checkpointPath, writeStart) {
    let stagingPath = checkpointPath
        ? validateStagingPath(targetPath, checkpointPath)
        : null;
    let opened;

    if (stagingPath) {
        try {
            opened = openExistingPrivateFile(stagingPath, fs.constants.O_RDWR);
        } catch (cause) {
            if (cause?.code !== 'ENOENT' || writeStart !== 0) {
                if (cause?.code === 'ENOENT') {
                    throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                        detail: { path: stagingPath, expectedMinimumSize: writeStart, actualSize: null },
                        cause
                    });
                }
                throw cause;
            }
            opened = createPrivateStagingFile(stagingPath);
        }
    } else {
        for (let attempt = 0; attempt < 16; attempt += 1) {
            stagingPath = stagingPathFor(targetPath);
            try {
                opened = createPrivateStagingFile(stagingPath);
                break;
            } catch (cause) {
                if (cause?.code !== 'EEXIST') throw cause;
            }
        }
        if (!opened) {
            throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                detail: { reason: 'unable to allocate staging file' }
            });
        }
    }

    try {
        if (opened.stat.size < writeStart) {
            throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                detail: { path: stagingPath, expectedMinimumSize: writeStart, actualSize: opened.stat.size }
            });
        }
        if (opened.stat.size !== writeStart) fs.ftruncateSync(opened.fd, writeStart);
        return { path: stagingPath, ...opened };
    } catch (cause) {
        try { fs.closeSync(opened.fd); } catch (_) {}
        throw cause;
    }
}

function fdOperation(operation, fd, ...args) {
    return new Promise((resolve, reject) => {
        operation(fd, ...args, (error, value) => error ? reject(error) : resolve(value));
    });
}

async function hashFileDescriptor(fd, size) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
        const length = Math.min(buffer.length, size - position);
        const bytesRead = await new Promise((resolve, reject) => {
            fs.read(fd, buffer, 0, length, position, (error, count) => {
                if (error) reject(error);
                else resolve(count);
            });
        });
        if (bytesRead === 0) {
            throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                detail: { expectedSize: size, actualSize: position }
            });
        }
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
    }
    return hash.digest('hex');
}

function expectedCompletedHash(output) {
    if (output.completedHash === undefined) return null;
    if (typeof output.completedHash !== 'string' || !/^[0-9a-f]{64}$/i.test(output.completedHash)) {
        throw invalidCheckpoint('output.completedHash', output.completedHash);
    }
    return output.completedHash.toLowerCase();
}

async function verifyPrivateFile(filePath, expectedSize, expectedHash, field) {
    let opened;
    try {
        opened = openExistingPrivateFile(filePath, fs.constants.O_RDONLY, field);
    } catch (cause) {
        if (cause?.code === 'ENOENT') {
            throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                detail: { path: filePath, expectedSize, actualSize: null },
                cause
            });
        }
        throw cause;
    }
    try {
        if (opened.stat.size !== expectedSize) {
            throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                detail: { path: filePath, expectedSize, actualSize: opened.stat.size }
            });
        }
        const actualHash = await hashFileDescriptor(opened.fd, expectedSize);
        if (expectedHash && actualHash !== expectedHash) {
            throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                detail: { path: filePath, reason: 'completed output hash mismatch' }
            });
        }
        return { hash: actualHash, stat: opened.stat };
    } finally {
        try { fs.closeSync(opened.fd); } catch (_) {}
    }
}

function isSameFileTerminalCheckpoint(ctx, filePath) {
    if (ctx.phase !== 'replacing' && ctx.phase !== 'complete') return false;
    if (ctx.output?.policy !== 'same-file-staging') return false;
    const requestedPath = resolveCheckpointPath(ctx.output.requestedPath, 'output.requestedPath');
    if (!sameResolvedPath(requestedPath, filePath)) {
        throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
            detail: { expected: requestedPath, actual: path.resolve(filePath) }
        });
    }
    return true;
}

function assertResumeTarget(filePath, writeStart) {
    if (writeStart === 0) return;
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (cause) {
        throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
            detail: { path: filePath, expectedMinimumSize: writeStart, actualSize: null },
            cause
        });
    }
    if (stat.size < writeStart) {
        throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
            detail: { path: filePath, expectedMinimumSize: writeStart, actualSize: stat.size }
        });
    }
    if (stat.size > writeStart) fs.truncateSync(filePath, writeStart);
}

export class RecoverableReadStream extends Readable {
    constructor(filePath, context, options = {}) {
        super(options);
        this.context = context;
        if (!this.context.context) this.context.context = {};
        if (this.context.context.checkpointVersion === undefined) {
            resetForLegacyMigration(this.context);
        }

        const ctx = this.context.context;
        const runtime = ensureRuntime(this.context);
        const readStart = ctx.readStart ?? 0;
        if (!Number.isSafeInteger(readStart) || readStart < 0) {
            throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
                detail: { field: 'readStart', value: readStart }
            });
        }
        if (ctx.data && ctx.data.length > 0) {
            throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
                detail: { field: 'data', reason: 'checkpoint is not on an item boundary' }
            });
        }

        runtime.sourcePath = path.resolve(filePath);
        runtime.rawCommitted = readStart;
        runtime.plainCommitted = ctx.writeStart ?? 0;
        runtime.pendingBlocks = [];
        runtime.unattributedPlain = 0;
        runtime.inputComplete = false;
        runtime.skipSealedInput = false;

        this.terminalCheckpoint = isSameFileTerminalCheckpoint(ctx, filePath);
        if (this.terminalCheckpoint) {
            // The source path may already contain plaintext: phase=replacing
            // covers both sides of the atomic rename, and phase=complete is an
            // idempotent replay.  Do not hand either state to the sealed parser.
            runtime.inputComplete = true;
            runtime.skipSealedInput = true;
            this.inputStream = null;
            this.state = 'complete';
            this.headerRead = HeaderSize;
            this.inputEnded = true;
            this.waitingReadable = false;
            this.pushedEof = false;
            return;
        }

        this.inputStream = new SealedFileStream(filePath, {
            start: readStart,
            highWaterMark: options.highWaterMark,
            expectedSource: ctx.source,
            resumeOffset: readStart,
            onMetadata: async (metadata) => {
                ctx.checkpointVersion = CONTEXT_VERSION;
                ctx.source = metadata;
                ctx.readStart = readStart;
                ctx.itemBoundary = readStart;
                ctx.writeStart = ctx.writeStart ?? 0;
                ctx.readItemCount = ctx.readItemCount ?? 0;
                ctx.data = Buffer.alloc(0);
                ctx.phase = 'processing';
                if (typeof this.context.saveContext === 'function') {
                    await this.context.saveContext();
                }
            }
        });
        this.state = 'header';
        this.headerRead = 0;
        this.inputEnded = false;
        this.waitingReadable = false;
        this.pushedEof = false;

        this.inputStream.on('error', (error) => this.destroy(error));
        this.inputStream.on('end', () => {
            this.inputEnded = true;
            if (this.state === 'header' && this.headerRead !== HeaderSize) {
                this.destroy(new MetaEncryptorError('ERR_UNEXPECTED_EOF'));
            } else {
                this._pushEof();
            }
        });
    }

    _pushEof() {
        if (this.pushedEof || this.destroyed) return;
        this.pushedEof = true;
        this.push(null);
    }

    _waitReadable(size) {
        if (this.waitingReadable || this.destroyed) return;
        this.waitingReadable = true;
        this.inputStream.once('readable', () => {
            this.waitingReadable = false;
            this._read(size);
        });
    }

    _read(size) {
        if (this.destroyed) return;
        if (this.terminalCheckpoint) {
            this._pushEof();
            return;
        }
        if (this.state === 'header') {
            const chunk = this.inputStream.read(Math.min(HeaderSize - this.headerRead, Math.max(size, 1)));
            if (chunk) {
                this.headerRead += chunk.length;
                this.push(chunk);
                if (this.headerRead === HeaderSize) {
                    this.state = 'remaining';
                    this.context.context.status = 'file';
                }
                return;
            }
            if (this.inputEnded || this.inputStream.readableEnded) {
                this.destroy(new MetaEncryptorError('ERR_UNEXPECTED_EOF'));
            } else {
                this._waitReadable(size);
            }
            return;
        }

        const chunk = this.inputStream.read(Math.max(size, 1));
        if (chunk) {
            this.push(chunk);
        } else if (this.inputEnded || this.inputStream.readableEnded) {
            this._pushEof();
        } else {
            this._waitReadable(size);
        }
    }

    _destroy(error, callback) {
        if (this.inputStream && !this.inputStream.destroyed) this.inputStream.destroy();
        callback(error);
    }
}

export class RecoverableWriteStream extends Writable {
    constructor(filePath, context, options = {}) {
        super(options);
        this.context = context;
        if (!this.context.context) this.context.context = {};
        this.context.context.checkpointVersion ??= CONTEXT_VERSION;
        this.runtime = ensureRuntime(this.context);
        this.requestedPath = path.resolve(filePath);
        this.writeStart = this.context.context.writeStart ?? 0;
        if (!Number.isSafeInteger(this.writeStart) || this.writeStart < 0) {
            throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
                detail: { field: 'writeStart', value: this.writeStart }
            });
        }

        const ctx = this.context.context;
        let checkpointOutput = ctx.output;
        if (checkpointOutput !== undefined &&
            (!checkpointOutput || typeof checkpointOutput !== 'object' || Array.isArray(checkpointOutput))) {
            throw invalidCheckpoint('output', checkpointOutput);
        }
        let checkpointRequestedPath = null;
        if (checkpointOutput) {
            checkpointRequestedPath = resolveCheckpointPath(
                checkpointOutput.requestedPath,
                'output.requestedPath'
            );
            if (!sameResolvedPath(checkpointRequestedPath, this.requestedPath)) {
                throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                    detail: { expected: checkpointRequestedPath, actual: this.requestedPath }
                });
            }
            if (checkpointOutput.policy !== 'same-file-staging' &&
                checkpointOutput.policy !== 'separate-file') {
                throw invalidCheckpoint('output.policy', checkpointOutput.policy);
            }
        }

        const checkpointSameFile = checkpointOutput?.policy === 'same-file-staging';
        this.coupled = Boolean(this.runtime.sourcePath) || ctx.status === 'file' || checkpointSameFile;
        this.sameFile = checkpointSameFile ||
            (this.coupled && sameFileIdentity(this.runtime.sourcePath, this.requestedPath));
        const expectedPolicy = this.sameFile ? 'same-file-staging' : 'separate-file';
        if (checkpointOutput && checkpointOutput.policy !== expectedPolicy) {
            throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                detail: { expected: checkpointOutput, actual: { requestedPath: this.requestedPath, policy: expectedPolicy } }
            });
        }

        this.activeFd = null;
        this.activeIdentity = null;
        this.resumeFinalization = this.sameFile &&
            (ctx.phase === 'replacing' || ctx.phase === 'complete');

        if (this.sameFile) {
            if (this.resumeFinalization) {
                if (!checkpointOutput?.stagingPath) {
                    throw invalidCheckpoint('output.stagingPath', checkpointOutput?.stagingPath);
                }
                this.activePath = validateStagingPath(this.requestedPath, checkpointOutput.stagingPath);
                this.writeStream = null;
                this._finalSettle = null;
                return;
            }

            const opened = openStagingForWrite(
                this.requestedPath,
                checkpointOutput?.stagingPath,
                this.writeStart
            );
            this.activePath = opened.path;
            this.activeFd = opened.fd;
            this.activeIdentity = opened.stat;
            ctx.output = {
                ...checkpointOutput,
                requestedPath: this.requestedPath,
                policy: expectedPolicy,
                stagingPath: this.activePath
            };
        } else {
            this.activePath = this.requestedPath;
            ctx.output = { ...checkpointOutput, requestedPath: this.requestedPath, policy: expectedPolicy };
        }

        if (this.sameFile) {
            this.writeStream = fs.createWriteStream(this.activePath, {
                fd: this.activeFd,
                autoClose: false,
                start: this.writeStart,
                mode: 0o600
            });
        } else {
            assertResumeTarget(this.activePath, this.writeStart);
            const flags = this.writeStart > 0 ? 'r+' : 'w';
            this.writeStream = fs.createWriteStream(this.activePath, {
                flags,
                start: this.writeStart,
                mode: 0o600
            });
        }
        this._finalSettle = null;
        this.writeStream.on('error', (error) => {
            if (this._finalSettle) this._finalSettle(error);
            else if (!this.destroyed) this.destroy(error);
        });
    }

    async _saveContext() {
        if (typeof this.context.saveContext === 'function') await this.context.saveContext();
    }

    _drainCommitted(writtenBytes = 0) {
        const ctx = this.context.context;
        const runtime = this.runtime;

        if (!this.coupled) {
            runtime.plainCommitted += writtenBytes;
            ctx.writeStart = runtime.plainCommitted;
            ctx.itemBoundary = ctx.readStart ?? 0;
            return writtenBytes > 0;
        }

        let remain = runtime.unattributedPlain + writtenBytes;
        runtime.unattributedPlain = 0;
        let committed = false;
        let committedItems = 0;
        while (runtime.pendingBlocks.length > 0) {
            const block = runtime.pendingBlocks[0];
            if (block.remainingPlain !== 0 && remain === 0) break;
            const consumed = Math.min(remain, block.remainingPlain);
            block.remainingPlain -= consumed;
            remain -= consumed;
            if (block.remainingPlain === 0) {
                runtime.rawCommitted += block.rawSize;
                runtime.plainCommitted += block.plainSize;
                runtime.pendingBlocks.shift();
                committed = true;
                committedItems += 1;
                if (block.dataHash) ctx.dataHash = Buffer.from(block.dataHash);
            }
        }
        runtime.unattributedPlain = remain;

        if (committed) {
            ctx.readStart = runtime.rawCommitted;
            ctx.itemBoundary = runtime.rawCommitted;
            ctx.writeStart = runtime.plainCommitted;
            ctx.readItemCount = (ctx.readItemCount ?? 0) + committedItems;
            ctx.data = Buffer.alloc(0);
        }
        return committed;
    }

    _write(chunk, encoding, callback) {
        if (this.resumeFinalization) {
            callback(new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
                detail: { reason: 'completed same-file checkpoint received new plaintext' }
            }));
            return;
        }
        this.writeStream.write(chunk, encoding, (error) => {
            if (error) {
                callback(error);
                return;
            }
            try {
                const changed = this._drainCommitted(chunk.length);
                if (changed) {
                    this._saveContext().then(() => callback(), callback);
                } else {
                    callback();
                }
            } catch (cause) {
                callback(cause);
            }
        });
    }

    async _closeActiveFile() {
        if (this.activeFd === null) return;
        const fd = this.activeFd;
        this.activeFd = null;
        await fdOperation(fs.close, fd);
    }

    async _finalizeRecoveredSameFile() {
        const ctx = this.context.context;
        const output = ctx.output;
        const expectedSize = output.completedSize ?? ctx.writeStart;
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
            throw invalidCheckpoint('output.completedSize', expectedSize);
        }
        const expectedHash = expectedCompletedHash(output);
        let verified;

        if (ctx.phase === 'replacing') {
            let stagingExists = true;
            try {
                fs.lstatSync(this.activePath);
            } catch (cause) {
                if (cause?.code === 'ENOENT') stagingExists = false;
                else throw invalidCheckpoint('output.stagingPath', this.activePath, cause);
            }

            if (stagingExists) {
                verified = await verifyPrivateFile(
                    this.activePath,
                    expectedSize,
                    expectedHash,
                    'output.stagingPath'
                );
                // Keep verification and replacement adjacent.  The identity
                // check catches a path swap after the file descriptor closed.
                assertPathIdentity(this.activePath, verified.stat);
                try {
                    fs.renameSync(this.activePath, this.requestedPath);
                } catch (cause) {
                    throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                        detail: { reason: 'unable to replace sealed source' },
                        cause
                    });
                }
            } else {
                // rename() may already have succeeded before the process died.
                // Verify the now-plaintext target instead of parsing it as a
                // sealed source again.
                verified = await verifyPrivateFile(
                    this.requestedPath,
                    expectedSize,
                    expectedHash,
                    'output.requestedPath'
                );
            }
        } else if (ctx.phase === 'complete') {
            verified = await verifyPrivateFile(
                this.requestedPath,
                expectedSize,
                expectedHash,
                'output.requestedPath'
            );
        } else {
            throw invalidCheckpoint('phase', ctx.phase);
        }

        output.completedSize = expectedSize;
        output.completedHash = verified.hash;
        ctx.writeStart = expectedSize;
        ctx.phase = 'complete';
        this.runtime.plainCommitted = expectedSize;
        this.runtime.inputComplete = true;
        this.runtime.skipSealedInput = true;
        await this._saveContext();
    }

    _final(callback) {
        if (this.resumeFinalization) {
            this._finalizeRecoveredSameFile().then(
                () => callback(),
                (error) => callback(error)
            );
            return;
        }
        const inner = this.writeStream;
        let settled = false;
        let finalizing = false;

        const cleanup = () => {
            inner.removeListener('finish', finalize);
            inner.removeListener('close', onClose);
            if (this._finalSettle === settle) this._finalSettle = null;
        };
        const settle = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(error);
        };
        const finalize = async () => {
            if (settled || finalizing) return;
            finalizing = true;
            try {
                this._drainCommitted(0);
                if (this.coupled && this.runtime.inputComplete &&
                    (this.runtime.unattributedPlain !== 0 || this.runtime.pendingBlocks.length !== 0)) {
                    throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
                        detail: {
                            unattributedPlain: this.runtime.unattributedPlain,
                            pendingBlocks: this.runtime.pendingBlocks.length
                        }
                    });
                }

                const finalSize = this.runtime.plainCommitted;
                let stagingStat = null;
                if (this.sameFile) {
                    stagingStat = fs.fstatSync(this.activeFd);
                    assertRegularPrivateFile(stagingStat, 'output.stagingPath', this.activePath);
                    if (!sameFileStat(stagingStat, this.activeIdentity)) {
                        throw invalidCheckpoint('output.stagingPath', this.activePath);
                    }
                    assertPathIdentity(this.activePath, stagingStat);
                    await fdOperation(fs.ftruncate, this.activeFd, finalSize);
                } else {
                    await fs.promises.truncate(this.activePath, finalSize);
                }
                const ctx = this.context.context;
                ctx.readStart = this.runtime.rawCommitted;
                ctx.itemBoundary = this.runtime.rawCommitted;
                ctx.writeStart = finalSize;
                ctx.data = Buffer.alloc(0);

                if (this.sameFile && this.runtime.inputComplete) {
                    await fdOperation(fs.fsync, this.activeFd);
                    const completedHash = await hashFileDescriptor(this.activeFd, finalSize);
                    ctx.output.completedSize = finalSize;
                    ctx.output.completedHash = completedHash;
                    ctx.phase = 'replacing';
                    await this._saveContext();
                    await this._closeActiveFile();
                    assertPathIdentity(this.activePath, stagingStat);
                    try {
                        fs.renameSync(this.activePath, this.requestedPath);
                    } catch (cause) {
                        throw new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                            detail: { reason: 'unable to replace sealed source' },
                            cause
                        });
                    }
                    ctx.phase = 'complete';
                    await this._saveContext();
                } else {
                    ctx.phase = this.runtime.inputComplete ? 'complete' : 'processing';
                    await this._saveContext();
                    if (this.sameFile) await this._closeActiveFile();
                }
                settle();
            } catch (error) {
                settle(error);
            }
        };
        const onClose = () => {
            if (!inner.writableFinished) {
                settle(new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                    detail: { reason: 'inner stream closed before finalize' }
                }));
            }
        };

        this._finalSettle = settle;
        if (inner.writableFinished) {
            void finalize();
        } else if (inner.destroyed) {
            settle(new MetaEncryptorError('ERR_OUTPUT_MISMATCH', {
                detail: { reason: 'inner stream destroyed before finalize' }
            }));
        } else {
            inner.once('finish', finalize);
            inner.once('close', onClose);
            inner.end();
        }
    }

    _destroy(error, callback) {
        if (this.writeStream && !this.writeStream.destroyed) this.writeStream.destroy();
        if (this.activeFd !== null) {
            try { fs.closeSync(this.activeFd); } catch (_) {}
            this.activeFd = null;
        }
        callback(error);
    }
}
