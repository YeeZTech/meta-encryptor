export function detectBrowserCapabilities() {
  const ua = navigator.userAgent.toLowerCase()
  const isMobile = /android|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua)
  
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
  
  const capabilities = {
    serviceWorker: 'serviceWorker' in navigator,
    messageChannel: typeof MessageChannel !== 'undefined',
    readableStream: typeof ReadableStream !== 'undefined',
    streamSaver: typeof window !== 'undefined' && window.streamSaver && typeof window.streamSaver.createWriteStream === 'function',
    fileSystemAccess: typeof window !== 'undefined' && 'showSaveFilePicker' in window,
    blob: typeof Blob !== 'undefined' && typeof URL !== 'undefined' && 'createObjectURL' in URL,
  }
  
  // Known-broken browsers that don't support ServiceWorker + MessageChannel + ReadableStream
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

