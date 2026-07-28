import { Transform, Readable, Writable } from 'stream';

export class ToString extends Transform {
  constructor(options?: any, schema?: any);
}

export class Sealer extends Transform {
  constructor(options?: {
    keyPair: any;
    hashProvider?: SealedHashProvider;
    [key: string]: any;
  });
}

export class Unsealer extends Transform {
  constructor(options?: {
    keyPair: any;
    context?: any;
    progressHandler?: (...args: any[]) => void;
    hashProvider?: SealedHashProvider;
    [key: string]: any;
  });
}

export class SealedFileStream extends Readable {
  constructor(filePath: string, options?: any);
}

/** PipelineContext / PipelineContextInFile 配置 */
export interface PipelineContextOptions {
  /**
   * 落盘频率：每提交多少个 item 调用一次 saveContext。
   * 默认 32。流结束（_final）仍会强制落盘。
   */
  saveFrequency?: number;
  /**
   * 强一致性保证：为 true 时 save 落盘会 fsync。
   * 默认 false（省略 fsync，提升吞吐）。
   */
  strongConsistency?: boolean;
  [key: string]: any;
}

export class PipelineContext {
  context: Record<string, any>;
  options: PipelineContextOptions;
  constructor(options?: PipelineContextOptions);
  update(key: string, value: any): void;
  saveContext(): Promise<void> | void;
  loadContext(): Promise<void> | void;
}

export class PipelineContextInFile extends PipelineContext {
  constructor(filePath: string, options?: PipelineContextOptions);
  saveContext(): Promise<void>;
  loadContext(): Promise<void>;
}

export class RecoverableReadStream extends Readable {
  constructor(filePath: string, context: PipelineContext, options?: any);
}

export class RecoverableWriteStream extends Writable {
  constructor(filePath: string, context: PipelineContext, options?: any);
}

// Sealed file utilities
export function isSealedFile(filePath: string): boolean;
export function sealedFileVersion(filePath: string): number;
export function dataHashOfSealedFile(filePath: string): Buffer | null;
export function signedDataHash(keyPair: any, dataHash: Buffer): Buffer;
export function forwardSkey(keyPair: any, dianPKey: any, enclaveHash?: Buffer): { encrypted_skey: Buffer; forward_sig: Buffer };
/**
 * 可注入的 keccak 实现。
 * Node 默认会优先用 optionalDependency `keccak` 原生 addon（约 350MB/s），
 * 不可用时回退 @noble/hashes 纯 JS（约 20~40MB/s）；也可用本接口强制指定。
 */
export interface SealedHashProvider {
  keccak256(data: Uint8Array): Uint8Array;
}

/** Node 侧当前生效的 keccak 实现；浏览器入口不导出此函数 */
export function getKeccakImplementation(): 'native' | 'js';

export function calculateSealedHash(
  filePath: string,
  options?: { hashProvider?: SealedHashProvider }
): string;

/** 可 JSON 持久化的扫描断点；与 fileSize + itemCount 绑定，换文件即失效 */
export interface SealedHashCheckpoint {
  version: number;
  fileSize: number;
  itemCount: number;
  itemIndex: number;
  offset: number;
  /** 已扫过部分的滚动哈希（十六进制） */
  hash: string;
}

export interface SealedHashProgress {
  bytesRead: number;
  totalBytes: number;
  itemIndex: number;
  itemCount: number;
  /** 0 ~ 1 */
  progress: number;
}

export interface CalculateSealedHashAsyncOptions {
  onProgress?: (progress: SealedHashProgress) => void;
  onCheckpoint?: (checkpoint: SealedHashCheckpoint) => void;
  signal?: AbortSignal;
  checkpoint?: SealedHashCheckpoint | null;
  hashProvider?: SealedHashProvider;
  /** 单次读盘窗口，默认 4MiB */
  chunkSize?: number;
  /** 每扫过多少字节让出一次事件循环，默认 1MiB */
  yieldEveryBytes?: number;
}

/**
 * 异步计算密封文件哈希：分片让出事件循环，不会冻结 UI 线程。
 * 取消时抛 MetaEncryptorError('ERR_SEALED_HASH_ABORTED')，`detail.checkpoint` 可用于续算。
 */
export function calculateSealedHashAsync(
  filePath: string,
  options?: CalculateSealedHashAsyncOptions
): Promise<string>;

// DataProvider (constructor-style API)
export class DataProviderClass {
  header: any;
  block_meta_info: any[];
  sealed_data: any[];
  data_lines: any[];
  counter: number;
  key_pair: any;
  constructor(keyPair: any, options?: { hashProvider?: SealedHashProvider });
  write_batch(batch: any, public_key: string, writable_stream?: any): void;
  sealData(input: any, writable_stream?: any, is_end?: boolean): any;
  setHeaderAndMeta(): { headerInfo: Buffer; blockInfo: Buffer; meta: any };
  static headerAndBlockBufferFromBuffer(buf: Buffer): { header: Buffer; block: Buffer } | null;
}

export const DataProvider: typeof DataProviderClass;
export const checkSealedData: any;
export const unsealData: any;

export const YPCNtObject: any;
export const YPCCrypto: any;

export { Sealer as defaultSealer };

export default {
  ToString,
  Sealer,
  Unsealer,
  SealedFileStream,
  PipelineContext,
  PipelineContextInFile,
  RecoverableReadStream,
  RecoverableWriteStream,
  isSealedFile,
  sealedFileVersion,
  dataHashOfSealedFile,
  signedDataHash,
  forwardSkey,
  calculateSealedHash,
  calculateSealedHashAsync,
  DataProvider,
  checkSealedData,
  unsealData,
  YPCNtObject,
  YPCCrypto
};
