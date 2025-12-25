// 导出 BrowserCrypto 和 YPCCrypto（同一个对象，不同名称）
export { BrowserCrypto, default as YPCCrypto } from './ypccrypto.browser.js';
export { UnsealerBrowser, unsealStream } from './UnsealerBrowser.js';
export { downloadUnsealed } from './downloadUnsealed.js';