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

export const { DataProvider, checkSealedData, unsealData } = Provider;

export const YPCNtObject = YPCNt_Object();
export const YPCCrypto = nodeYPCCrypto();

