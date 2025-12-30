import ypccrypto from "./ypccrypto";
import YPCNt_Object from './ypcntobject';

export const YPCNtObject = YPCNt_Object()
export const YPCCrypto = ypccrypto();

export const supportsConstruct = function() {
  // Node.js 15.0.0 引入了 _construct 方法
  const nodeVersion = process.version;
  const versionParts = nodeVersion.slice(1).split('.').map(Number);
  const majorVersion = versionParts[0];
  return majorVersion >= 15;
}
