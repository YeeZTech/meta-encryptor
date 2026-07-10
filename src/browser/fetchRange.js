import { MetaEncryptorError } from '../common/errors.js';

/** Resolve the final URL after redirects without losing compatibility with mocks. */
export function resolvedFetchUrl(response, requestUrl) {
  return response?.url || requestUrl;
}

function getFetch(fetchFn) {
  const candidate = fetchFn || globalThis.fetch;
  if (typeof candidate !== 'function') {
    throw new MetaEncryptorError('ERR_FETCH_UNAVAILABLE');
  }
  return candidate.bind(globalThis);
}

function validateRange(start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { reason: 'invalid HTTP byte range', start, end }
    });
  }
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(value || '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (![start, end].every(Number.isSafeInteger) || (total !== null && !Number.isSafeInteger(total))) {
    return null;
  }
  return { start, end, total };
}

function entityChanged(detail) {
  return new MetaEncryptorError('ERR_HTTP_ENTITY_CHANGED', { detail });
}

function isSameOrigin(url) {
  const current = globalThis.location;
  if (!current?.href || !current?.origin) return true;
  try {
    const requestOrigin = new URL(url, current.href).origin;
    return requestOrigin !== 'null' && requestOrigin === current.origin;
  } catch {
    return false;
  }
}

/**
 * Fetch an exact inclusive byte range. The response must be a 206. When CORS
 * makes Content-Range or entity validators visible, they are checked exactly;
 * callers still verify the decoded body length and final sealed-file hash.
 */
export async function fetchRange(url, {
  start,
  end,
  fetch: fetchFn,
  signal,
  expectedUrl,
  etag,
  lastModified,
  totalSize,
} = {}) {
  validateRange(start, end);
  const _fetch = getFetch(fetchFn);
  const rangeHeader = `bytes=${start}-${end}`;
  const headers = { Range: rangeHeader };
  const ifRange = etag && !/^W\//i.test(etag) ? etag : lastModified;
  const sameOrigin = isSameOrigin(url);
  // Range with a single byte range is CORS-safelisted, but If-Range is not.
  // Keep cross-origin downloads compatible with servers that allow ordinary
  // CORS GET/HEAD requests without also implementing an OPTIONS preflight.
  const sentIfRange = Boolean(ifRange && sameOrigin);
  if (sentIfRange) headers['If-Range'] = ifRange;

  const resp = await _fetch(url, {
    headers,
    cache: 'no-store',
    redirect: 'follow',
    signal,
  });
  const finalUrl = resolvedFetchUrl(resp, url);
  if (expectedUrl && finalUrl !== expectedUrl) {
    throw entityChanged({ reason: 'final URL changed', expectedUrl, actualUrl: finalUrl });
  }
  if (resp.status !== 206) {
    if (resp.status === 200 && sentIfRange) {
      throw entityChanged({ reason: 'If-Range precondition failed', status: resp.status, rangeHeader });
    }
    throw new MetaEncryptorError('ERR_RANGE_NOT_HONORED', {
      detail: { status: resp.status, rangeHeader, expectedStatus: 206 }
    });
  }
  if (!resp.ok) {
    throw new MetaEncryptorError('ERR_CANNOT_READ_TAIL', {
      detail: { status: resp.status, rangeHeader }
    });
  }

  const contentRange = resp.headers.get('Content-Range');
  // Content-Range is not a CORS-safelisted response header. A cross-origin
  // response can therefore contain it while JavaScript sees null unless the
  // server lists it in Access-Control-Expose-Headers. Validate it whenever it
  // is observable; otherwise the callers' exact body-length checks and the
  // unsealer's final data-hash verification remain authoritative.
  if (contentRange === null && sameOrigin) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: {
        reason: 'missing Content-Range',
        expected: `bytes ${start}-${end}`,
        actual: null
      }
    });
  }
  if (contentRange !== null) {
    const parsed = parseContentRange(contentRange);
    if (!parsed || parsed.start !== start || parsed.end !== end) {
      throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
        detail: {
          reason: 'invalid Content-Range',
          expected: `bytes ${start}-${end}`,
          actual: contentRange
        }
      });
    }
    if (totalSize !== undefined && parsed.total !== totalSize) {
      throw entityChanged({ reason: 'entity size changed', expectedSize: totalSize, actualSize: parsed.total });
    }
  }

  const responseEtag = resp.headers.get('ETag');
  if (etag && responseEtag && responseEtag !== etag) {
    throw entityChanged({ reason: 'ETag changed', expectedEtag: etag, actualEtag: responseEtag });
  }
  const responseLastModified = resp.headers.get('Last-Modified');
  // Fall back to Last-Modified when the range response does not expose ETag,
  // even if ETag was visible on HEAD.
  if ((!etag || !responseEtag) && lastModified && responseLastModified &&
      responseLastModified !== lastModified) {
    throw entityChanged({
      reason: 'Last-Modified changed',
      expectedLastModified: lastModified,
      actualLastModified: responseLastModified,
    });
  }

  return { response: resp, finalUrl };
}
