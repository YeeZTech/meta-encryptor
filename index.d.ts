import { Transform, Readable, Writable } from 'stream';

export class ToString extends Transform {
  constructor(options?: any, schema?: any);
}

export class Sealer extends Transform {
  constructor(options?: any);
}

export class Unsealer extends Transform {
  constructor(options?: any);
}

export class SealedFileStream extends Readable {
  constructor(filePath: string, options?: any);
}

export class PipelineContext {
  context: Record<string, any>;
  options: any;
  constructor(options?: any);
  update(key: string, value: any): void;
  saveContext(): Promise<void> | void;
  loadContext(): Promise<void> | void;
}

export class PipelineContextInFile extends PipelineContext {
  constructor(filePath: string, options?: any);
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
export function calculateSealedHash(filePath: string): string;

// DataProvider (constructor-style API)
export class DataProviderClass {
  header: any;
  block_meta_info: any[];
  sealed_data: any[];
  data_lines: any[];
  counter: number;
  key_pair: any;
  constructor(keyPair: any);
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
  DataProvider,
  checkSealedData,
  unsealData,
  YPCNtObject,
  YPCCrypto
};
