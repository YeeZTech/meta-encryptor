/* eslint-disable */
import { BrowserCrypto } from "./browser/ypccrypto.browser.js";

export const YPCCrypto = BrowserCrypto;

export { BrowserCrypto };

export { configureLocale, detectLocale } from "./common/locale.js";
export { MetaEncryptorError } from "./common/errors.js";

export { Unsealer } from "./browser/Unsealer.js";

export { HttpSealedFileStream } from "./browser/HttpSealedFileStream.js";

export { downloadUnsealed, inspectSealed } from "./browser/downloadUnsealed.js";

export { streamDownloadAndDecrypt, getBestWritable } from "./browser/stream_download.js";

export { blobDownloadAndDecrypt } from "./browser/blob_download.js";

export { createProgressTransformer, createDownloadReadyTransformer } from "./common/progress.js";

export { HeaderSize, BlockInfoSize, MaxItemSize } from "./common/limits.js";
export { validateHeader, UnsealerCore } from "./common/unsealer_core.js";
export { createInactivityWatchdog } from "./common/watchdog.js";

