// 浏览器能力检测工具
// 用于检测浏览器类型和 API 支持情况，帮助选择合适的下载方案

export function detectBrowserCapabilities() {
  const ua = navigator.userAgent.toLowerCase()
  const isMobile = /android|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua)
  
  // 检测浏览器类型
  const browserInfo = {
    isMobile,
    isBaidu: /baiduboxapp|baidubrowser/i.test(ua),
    isQQ: /mqqbrowser|qzone/i.test(ua),
    isUC: /ucbrowser|ucweb/i.test(ua),
    isQuark: /quark/i.test(ua),
    isXiaomi: /miuibrowser/i.test(ua),
    isWeChat: /micromessenger/i.test(ua),
    isChrome: /chrome/i.test(ua) && !/edge|edg/i.test(ua),
    isEdge: /edge|edg/i.test(ua),
    isSafari: /safari/i.test(ua) && !/chrome|crios|fxios/i.test(ua),
  }
  
  // 检测 API 支持
  const capabilities = {
    serviceWorker: 'serviceWorker' in navigator,
    messageChannel: typeof MessageChannel !== 'undefined',
    readableStream: typeof ReadableStream !== 'undefined',
    streamSaver: typeof window !== 'undefined' && window.streamSaver && typeof window.streamSaver.createWriteStream === 'function',
    fileSystemAccess: typeof window !== 'undefined' && 'showSaveFilePicker' in window,
    blob: typeof Blob !== 'undefined' && typeof URL !== 'undefined' && 'createObjectURL' in URL,
  }
  
  // 针对已知有问题的浏览器，禁用某些功能
  // 这些浏览器对 Service Worker + MessageChannel + ReadableStream 的支持不完整
  const shouldSkipServiceWorker = 
    browserInfo.isBaidu || 
    browserInfo.isQQ || 
    browserInfo.isUC || 
    browserInfo.isQuark || 
    browserInfo.isXiaomi ||
    (isMobile && !browserInfo.isChrome && !browserInfo.isEdge && !browserInfo.isSafari)
  
  return {
    browserInfo,
    capabilities: {
      ...capabilities,
      serviceWorker: capabilities.serviceWorker && !shouldSkipServiceWorker,
    },
    shouldSkipServiceWorker,
  }
}

