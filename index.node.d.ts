import { Readable, Transform, Writable } from 'node:stream';

export interface KeyPair {
  private_key: string;
  public_key: string;
}

export class MetaEncryptorError extends Error {
  code: string;
  detail?: unknown;
  readonly localizedMessage: string;
  constructor(code: string, options?: { detail?: unknown; cause?: unknown });
  toJSON(): {
    name: string;
    code: string;
    message: string;
    detail?: unknown;
    causeMessage?: string;
  };
}

export function configureLocale(options?: { messages?: Record<string, string> | null }): void;
export function detectLocale(): string;

export class ToString extends Transform {
  constructor(options?: object, schema?: unknown);
}

export class Sealer extends Transform {
  constructor(options: { keyPair: KeyPair; [key: string]: unknown });
}

export interface UnsealerOptions {
  keyPair: KeyPair;
  progressHandler?: (totalItems: number, processedItems: number, readBytes: number, writeBytes: number) => void;
  context?: PipelineContext;
  processedItemCount?: number;
  processedBytes?: number;
  writeBytes?: number;
  /** Override the 64 MiB safe default when recovering larger historical v2 items. */
  maxSealedItemSize?: number;
  [key: string]: unknown;
}

export class Unsealer extends Transform {
  constructor(options: UnsealerOptions);
}

export class SealedFileStream extends Readable {
  readonly streamSize: number;
  readonly contentSize: number;
  constructor(filePath: string, options?: { start?: number; end?: number; [key: string]: unknown });
}

export interface PipelineCheckpoint {
  version?: number;
  readStart?: number;
  writeStart?: number;
  readItemCount?: number;
  data?: Uint8Array;
  dataHash?: Uint8Array;
  [key: string]: unknown;
}

export class PipelineContext {
  context: PipelineCheckpoint;
  options: Record<string, unknown>;
  runtime: Record<string, unknown>;
  constructor(options?: Record<string, unknown>);
  update(key: string, value: unknown): void;
  saveContext(): Promise<void> | void;
  loadContext(): Promise<void> | void;
}

export class PipelineContextInFile extends PipelineContext {
  constructor(filePath: string, options?: Record<string, unknown>);
  saveContext(): Promise<void>;
  loadContext(): Promise<void>;
}

export class RecoverableReadStream extends Readable {
  constructor(filePath: string, context: PipelineContext, options?: Record<string, unknown>);
}

export class RecoverableWriteStream extends Writable {
  constructor(filePath: string, context: PipelineContext, options?: Record<string, unknown>);
}

export function isSealedFile(filePath: string): boolean;
export function sealedFileVersion(filePath: string): number;
export function dataHashOfSealedFile(filePath: string): Buffer | null;
export function signedDataHash(keyPair: KeyPair, dataHash: Buffer): Buffer;
export function forwardSkey(
  keyPair: KeyPair,
  dianPKey: Uint8Array | string,
  enclaveHash?: Buffer
): { encrypted_skey: Buffer; forward_sig: Buffer };
export function calculateSealedHash(filePath: string): string;

export class DataProviderClass {
  header: unknown;
  block_meta_info: unknown[];
  sealed_data: unknown[];
  data_lines: unknown[];
  counter: number;
  key_pair: KeyPair;
  constructor(keyPair: KeyPair);
  write_batch(batch: unknown, publicKey: string, writableStream?: Writable): void;
  sealData(input: unknown, writableStream?: Writable, isEnd?: boolean): unknown;
  setHeaderAndMeta(): { headerInfo: Buffer; blockInfo: Buffer; meta: unknown };
  static headerAndBlockBufferFromBuffer(buf: Buffer): { header: Buffer; block: Buffer } | null;
}

export const DataProvider: typeof DataProviderClass;
export const HeaderSize: number;
export const BlockInfoSize: number;
export const MaxItemSize: number;
export function validateHeader(headerBytes: Uint8Array): {
  itemNumber: number;
  blockNumber: number;
  dataHash?: Uint8Array;
};

export class UnsealerCore {
  constructor(options: Record<string, unknown>);
  processChunk(chunk: Uint8Array): Promise<void>;
  finalize(): void;
  verifyFinalState(): void;
  readonly finished: boolean;
  readonly headerReady: boolean;
  readonly totalItems: number;
  readonly readItemCount: number;
  readonly processedBytes: number;
  readonly writeBytes: number;
  remaining: Uint8Array;
}

export function createInactivityWatchdog(
  ms: number,
  onStall: () => void
): { kick(): void; stop(): void };

export const YPCNtObject: unknown;
export const YPCCrypto: {
  generatePrivateKey(): Buffer;
  generatePublicKeyFromPrivateKey(privateKey: Uint8Array | string): Buffer;
  generateEncryptedInput(publicKey: Uint8Array | string, input: ArrayBuffer | ArrayBufferView): Buffer;
  decryptMessage(privateKey: Uint8Array | string, message: Uint8Array): Buffer;
  [key: string]: unknown;
};
