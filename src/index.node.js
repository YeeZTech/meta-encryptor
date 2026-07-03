/* eslint-disable */
import Provider from "./node/DataProvider.js";
import YPCNt_Object from "./common/ypcntobject.js";
import nodeYPCCrypto from "./node/ypccrypto.js";

export { configureLocale, detectLocale } from "./common/locale.js";
export { MetaEncryptorError } from "./common/errors.js";

export { Sealer, ToString } from "./node/Sealer.js";

export { Unsealer } from "./node/Unsealer.js";

export { SealedFileStream } from "./node/SealedFileStream.js";
export {PipelineContext, PipelineContextInFile} from "./node/PipelineConext.js";
export {RecoverableReadStream, RecoverableWriteStream} from "./node/Recoverable.js";

export {
  isSealedFile,
  sealedFileVersion,
  dataHashOfSealedFile,
  signedDataHash,
  forwardSkey,
  calculateSealedHash
} from "./node/SealedFileUtil.js";

// NOTE: checkSealedData/unsealData were removed — they never existed on the
// DataProvider default export and were always `undefined`.
export const { DataProvider } = Provider;

export { HeaderSize, BlockInfoSize, MaxItemSize } from "./common/limits.js";
export { validateHeader, UnsealerCore } from "./common/unsealer_core.js";
export { createInactivityWatchdog } from "./common/watchdog.js";

export const YPCNtObject = YPCNt_Object();
export const YPCCrypto = nodeYPCCrypto();

