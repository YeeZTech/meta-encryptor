import { request } from './request.js'

export function downloadSealFileForStream(url, fileName, options) {
  return request.get(url, {
    params: {
      fileName,
      start: options && Number(options.start) || 0
    },
    responseType: 'stream'
  })
}