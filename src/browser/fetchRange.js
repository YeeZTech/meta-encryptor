import { MetaEncryptorError } from '../common/errors.js';

/**
 * After a HEAD/GET with redirect:'follow', use this URL for Range requests.
 * Avoids cross-origin opaque-redirect (status 0) when using redirect:'manual',
 * and avoids Safari dropping Range on auto-redirect follow.
 */
export function resolvedFetchUrl(response, requestUrl) {
  return response.url || requestUrl;
}

/**
 * @param {string} url - should be the post-redirect URL from resolvedFetchUrl when possible
 * @param {object} options
 * @param {number} options.start
 * @param {number} options.end
 * @param {Function} [options.fetch]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{response: Response, finalUrl: string}>}
 */
export async function fetchRange(url, { start, end, fetch: fetchFn, signal } = {}) {
  const _fetch = fetchFn || fetch.bind(globalThis);
  const rangeHeader = `bytes=${start}-${end}`;
  const expectedLen = end - start + 1;

  const resp = await _fetch(url, {
    headers: { Range: rangeHeader },
    cache: 'no-store',
    redirect: 'follow',
    signal,
  });

  if (!resp.ok) {
    throw new MetaEncryptorError('ERR_CANNOT_READ_TAIL', {
      detail: { status: resp.status, rangeHeader }
    });
  }

  // Detect when a proxy strips the Range header (200 instead of 206).
  // Some servers also respond 200 with Content-Range, which is valid.
  if (resp.status === 200) {
    const contentRange = resp.headers.get('Content-Range');
    if (!contentRange) {
      const cl = parseInt(resp.headers.get('Content-Length') || '0', 10);
      if (cl === 0 || cl > expectedLen * 2) {
        throw new MetaEncryptorError('ERR_RANGE_NOT_HONORED', {
          detail: {
            rangeHeader,
            expectedStatus: 206,
            actualStatus: resp.status,
            contentLength: cl,
            expectedLength: expectedLen,
          }
        });
      }
    }
  }

  return { response: resp, finalUrl: resolvedFetchUrl(resp, url) };
}
