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
