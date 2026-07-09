/**
 * Create a TransformStream that reports plaintext download progress.
 * Accumulates bytes from each chunk and calls onProgress.
 *
 * @param {number} plaintextSize - total plaintext size in bytes
 * @param {Function} onProgress - progress callback (totalSize, receivedBytes)
 * @returns {TransformStream}
 */
export function createProgressTransformer(plaintextSize, onProgress) {
  let received = 0
  return new TransformStream({
    transform(chunk, controller) {
      received += chunk.length
      if (onProgress) {
        onProgress(plaintextSize, received)
      }
      controller.enqueue(chunk)
    }
  })
}

/**
 * Create a TransformStream that fires once when the first chunk flows through.
 * Place after HttpSealedFileStream to signal download stream is ready (e.g. dismiss overlay).
 *
 * @param {Function} [onDownloadReady]
 * @returns {TransformStream}
 */
export function createDownloadReadyTransformer(onDownloadReady) {
  let called = false
  return new TransformStream({
    transform(chunk, controller) {
      if (!called) {
        called = true
        if (onDownloadReady) {
          onDownloadReady()
        }
      }
      controller.enqueue(chunk)
    }
  })
}
