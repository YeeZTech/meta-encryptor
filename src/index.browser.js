/* eslint-disable */
import { BrowserCrypto } from "./browser/ypccrypto.browser.js";

export const YPCCrypto = BrowserCrypto;

export { BrowserCrypto };

export { configureLocale, detectLocale } from "./common/locale.js";
export { MetaEncryptorError } from "./common/errors.js";

export { Unsealer } from "./browser/Unsealer.js";

export { HttpSealedFileStream } from "./browser/HttpSealedFileStream.js";

export { downloadUnsealed } from "./browser/downloadUnsealed.js";

export { streamDownloadAndDecrypt } from "./browser/stream_download.js";

