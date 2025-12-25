// 检测浏览器对 Transferable Objects 的支持
// 某些移动端浏览器（特别是基于旧版 Chromium 的）对 Transferable Objects 支持不完整

let supportsTransferable = null;

export function checkTransferableSupport() {
  if (supportsTransferable !== null) {
    return supportsTransferable;
  }

  try {
    // 检测 MessageChannel 是否支持 Transferable Objects
    const ch = new MessageChannel();
    const testBuffer = new ArrayBuffer(8);
    const view = new Uint8Array(testBuffer);
    view[0] = 0x42; // 设置一个测试值

    let received = false;
    const testPromise = new Promise((resolve) => {
      ch.port1.onmessage = (ev) => {
        received = true;
        // 如果 transfer 成功，原始 buffer 应该变成 detached (byteLength = 0)
        // 但接收端应该能收到数据
        if (ev.data && ev.data.buffer) {
          const receivedView = new Uint8Array(ev.data.buffer);
          resolve(receivedView[0] === 0x42);
        } else {
          resolve(false);
        }
      };
      ch.port1.onerror = () => resolve(false);
    });

    // 发送测试数据，使用 transfer
    ch.port2.postMessage({ data: testBuffer }, [testBuffer]);

    // 检查原始 buffer 是否被 detached
    const isDetached = testBuffer.byteLength === 0;

    // 等待接收
    return testPromise.then((receivedCorrectly) => {
      supportsTransferable = isDetached && receivedCorrectly;
      return supportsTransferable;
    }).catch(() => {
      supportsTransferable = false;
      return false;
    });
  } catch (e) {
    supportsTransferable = false;
    return Promise.resolve(false);
  }
}

// 同步检测（快速检测，可能不准确）
export function supportsTransferableSync() {
  if (supportsTransferable !== null) {
    return supportsTransferable;
  }

  // 简单检测：检查 MessageChannel 和 ArrayBuffer 是否存在
  if (typeof MessageChannel === 'undefined' || typeof ArrayBuffer === 'undefined') {
    return false;
  }

  // 对于移动端浏览器，保守地假设可能不支持
  const ua = navigator.userAgent.toLowerCase();
  const isProblematicBrowser = 
    /baiduboxapp|baidubrowser|mqqbrowser|ucbrowser|quark|miuibrowser/i.test(ua);

  if (isProblematicBrowser) {
    return false; // 保守地假设不支持
  }

  // 对于其他浏览器，假设支持（但实际使用时仍需要异步检测）
  return true;
}

