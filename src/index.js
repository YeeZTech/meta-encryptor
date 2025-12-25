/* eslint-disable */
import Provider from "./DataProvider";
import YPCNt_Object from "./ypcntobject";
// Node.js 环境：使用静态导入（默认）
import nodeYPCCrypto from "./ypccrypto.js";
// 浏览器环境：使用静态导入（Rollup 会在 ESM 构建时内联打包）
// 注意：CommonJS 构建也会包含此导入，但由于运行在 Node.js 环境，isBrowser 为 false，不会被使用
import browserYPCCrypto from "./browser/ypccrypto.browser.js";

// 根据环境自动选择 ypccrypto 实现
// 检测浏览器环境：使用多重条件确保准确性
// 优先检查明确的浏览器对象，而不是依赖 process 的不存在（因为构建工具可能会 polyfill process）
const isBrowser = typeof window !== 'undefined' || 
                  (typeof globalThis !== 'undefined' && globalThis.WorkerGlobalScope) ||
                  (typeof self !== 'undefined' && self.WorkerGlobalScope);

// 直接选择对应的实现（同步，无需异步加载）
// 对于 ESM 构建：Rollup 会内联打包浏览器版本，两个导入都存在
// 对于 CommonJS 构建：浏览器版本也会被打包，但由于运行在 Node.js 环境，isBrowser 为 false，使用 Node 版本
const YPCCryptoClass = isBrowser ? browserYPCCrypto : nodeYPCCrypto;

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

export const { DataProvider, checkSealedData, unsealData } = Provider;

export const YPCNtObject = YPCNt_Object();
export const YPCCrypto = YPCCryptoClass();
