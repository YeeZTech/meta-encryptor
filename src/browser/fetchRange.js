import { MetaEncryptorError } from '../common/errors.js';

const MAX_REDIRECTS = 10;

/**
 * @param {string} url
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

  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount <= MAX_REDIRECTS) {
    const resp = await _fetch(currentUrl, {
      headers: { Range: rangeHeader },
      redirect: 'manual',
      signal,
    });

    // Follow 3xx redirects manually, re-applying the Range header each time.
    // This is needed because Safari drops the Range header on auto-redirect.
    if (resp.status >= 300 && resp.status < 400 && resp.headers.has('location')) {
      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        throw new MetaEncryptorError('ERR_TOO_MANY_REDIRECTS', {
          detail: { url, redirectCount: MAX_REDIRECTS }
        });
      }
      const location = resp.headers.get('location');
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

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

    return { response: resp, finalUrl: currentUrl };
  }

  throw new MetaEncryptorError('ERR_TOO_MANY_REDIRECTS', {
    detail: { url, redirectCount: MAX_REDIRECTS }
  });
}
