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

export type ItemProgressHandler = (
  totalItems: number,
  processedItems: number,
  readBytes: number,
  writeBytes: number
) => void;
export type ByteProgressHandler = (estimatedTotalBytes: number, receivedBytes: number) => void;

export interface StreamSaverLike {
  createWriteStream(filename: string): WritableStream<Uint8Array>;
}

export interface DownloadOptions {
  url: string;
  privateKey: string;
  filename: string;
  onLog?: (message: string) => void;
  onProgress?: ItemProgressHandler;
  onByteProgress?: ByteProgressHandler;
  onDownloadReady?: () => void;
  onSuccess?: (result: { filename: string }) => void;
  onError?: (error: unknown) => void;
  timeoutMs?: number;
  maxSealedItemSize?: number;
  streamSaver?: StreamSaverLike;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface InspectSealedOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface SealedMetadata {
  totalSize: number;
  blockNumber: number;
  itemNumber: number;
  sealedContentSize: number;
  plaintextSizeEstimate: number;
  plaintextSize: number;
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
}

export function downloadUnsealed(options: DownloadOptions): Promise<void>;
export function inspectSealed(
  url: string,
  log?: (message: string) => void,
  options?: InspectSealedOptions
): Promise<SealedMetadata>;

export class Unsealer extends TransformStream<Uint8Array, Uint8Array> {
  constructor(options: {
    privateKeyHex: string;
    progressHandler?: ItemProgressHandler;
    maxSealedItemSize?: number;
  });
  readonly finished: boolean;
  readonly totalItems: number;
  readonly readItemCount: number;
}

export interface HttpSealedFileStreamOptions {
  chunkSize?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export class HttpSealedFileStream extends ReadableStream<Uint8Array> {
  readonly url: string;
  readonly finalUrl: string;
  readonly totalSize: number;
  readonly blockNumber: number;
  readonly itemNumber: number;
  readonly contentSize: number;
  constructor(url: string, options?: HttpSealedFileStreamOptions);
}

export interface DownloadPipelineOptions {
  log?: (message: string) => void;
  onProgress?: ItemProgressHandler;
  onByteProgress?: ByteProgressHandler;
  writable?: WritableStream<Uint8Array>;
  size?: number;
  sealedSize?: number;
  maxSize?: number;
  maxSealedItemSize?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  streamSaver?: StreamSaverLike;
  chunkSize?: number;
  onDownloadReady?: () => void;
  timeoutMs?: number;
}

export function getBestWritable(
  filename: string,
  options?: { log?: (message: string) => void; streamSaver?: StreamSaverLike }
): Promise<WritableStream<Uint8Array> | null>;
export function streamDownloadAndDecrypt(
  url: string,
  privateKeyHex: string,
  filename: string,
  options?: DownloadPipelineOptions
): Promise<{ ok: true }>;
export function blobDownloadAndDecrypt(
  url: string,
  privateKeyHex: string,
  filename: string,
  options?: DownloadPipelineOptions
): Promise<{ ok: true }>;

export function createProgressTransformer(
  plaintextSize: number,
  onByteProgress?: ByteProgressHandler
): TransformStream<Uint8Array, Uint8Array>;
export function createDownloadReadyTransformer(
  onDownloadReady?: () => void
): TransformStream<Uint8Array, Uint8Array>;
export function createInactivityWatchdog(
  ms: number,
  onStall: () => void
): { kick(): void; stop(): void };

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

export interface BrowserCryptoApi {
  generatePrivateKey(): Uint8Array;
  generatePublicKeyFromPrivateKey(privateKey: Uint8Array | string): Uint8Array;
  generateEncryptedInput(
    publicKey: Uint8Array | string,
    input: ArrayBuffer | ArrayBufferView
  ): Promise<Uint8Array>;
  decryptMessage(privateKey: Uint8Array | string, message: Uint8Array): Promise<Uint8Array>;
  [key: string]: unknown;
}

export const BrowserCrypto: BrowserCryptoApi;
export const YPCCrypto: BrowserCryptoApi;
