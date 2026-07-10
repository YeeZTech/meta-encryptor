/**
 * Create a TransformStream that reports plaintext download progress.
 * Accumulates bytes from each chunk and calls onProgress.
 *
 * `plaintextSize` is an over-estimate (the exact plaintext size cannot be
 * derived from the sealed header), so intermediate reports are clamped below
 * 100% and a final onProgress(total, total) is emitted from flush() when the
 * stream really completes.
 *
 * @param {number} plaintextSize - estimated total plaintext size in bytes
 * @param {Function} onByteProgress - byte progress callback (estimatedTotalBytes, receivedBytes)
 * @returns {TransformStream}
 */
export function createProgressTransformer(plaintextSize, onByteProgress) {
  let received = 0
  const hasSize = typeof plaintextSize === 'number' && plaintextSize > 0
  return new TransformStream({
    transform(chunk, controller) {
      received += chunk.length
      if (onByteProgress) {
        if (hasSize) {
          onByteProgress(plaintextSize, Math.min(received, Math.floor(plaintextSize * 0.99)))
        } else {
          onByteProgress(plaintextSize, received)
        }
      }
      controller.enqueue(chunk)
    },
    flush() {
      if (onByteProgress) {
        const total = hasSize ? plaintextSize : received
        onByteProgress(total, total)
      }
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
