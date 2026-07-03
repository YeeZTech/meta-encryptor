/* eslint-disable */
import Provider from "./DataProvider.js";
import YPCNt_Object from "../common/ypcntobject.js";
import nodeYPCCrypto from "./ypccrypto.js";

export { Sealer, ToString } from "./Sealer.js";

export { Unsealer } from "./Unsealer.js";

export { SealedFileStream } from "./SealedFileStream.js";
export {PipelineContext, PipelineContextInFile} from "./PipelineConext.js";
export {RecoverableReadStream, RecoverableWriteStream} from "./Recoverable.js";

export {
  isSealedFile,
  sealedFileVersion,
  dataHashOfSealedFile,
  signedDataHash,
  forwardSkey,
  calculateSealedHash
} from "./SealedFileUtil.js";

// NOTE: checkSealedData/unsealData were removed — they never existed on the
// DataProvider default export and were always `undefined`.
export const { DataProvider } = Provider;

export { HeaderSize, BlockInfoSize, MaxItemSize } from "../common/limits.js";
export { validateHeader, UnsealerCore } from "../common/unsealer_core.js";
export { createInactivityWatchdog } from "../common/watchdog.js";

export const YPCNtObject = YPCNt_Object();
export const YPCCrypto = nodeYPCCrypto();

