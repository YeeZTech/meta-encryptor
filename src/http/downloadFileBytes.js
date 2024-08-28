import { Buffer } from 'buffer'
import keccak256 from 'keccak256'
import { request } from './request.js'
import log from 'loglevel'

log.setLevel('ERROR')

export async function downloadFileBytes(downloadUrl, options, keepAliveCount = 5) {
  let hashIsEqual = false
  let response = undefined
  let error = null
  let count = 0
  while(!hashIsEqual && error === null && count < keepAliveCount) {
    count += 1
    response = await sendRequest(downloadUrl, options).catch((e) => {
      log.error('downloadFileBytes sendRequest catch', e)
      return e
    })
    if (!response || response.bytes === undefined || response.hash === undefined) {
      error = response
    } else {
      const hash = keccak256(Buffer.from(response.bytes)).toString('hex')
      hashIsEqual = hash === response.hash
    }
  }
  if (error !== null) {
    return Promise.reject(error)
  }
  if (!hashIsEqual && response && count >= keepAliveCount) {
    log.info('hashIsEqual', hashIsEqual)
    log.info('response', response)
    log.info('options', options)
    log.info('count', count)
    return Promise.reject('hash no equal')
  }
  log.info('last response', response)
  return response
}

async function sendRequest(downloadUrl, options) {
  if (!options.fileName || typeof options.start !== 'number') {
    return Promise.reject('Invalid parameters');
  }
  try {
    const res = await request.get(downloadUrl, {
      params: {
        fileName: options.fileName,
        start: options.start,
        length: options.length || ''
      },
    })
    const { data, hash } = res.data
    if (!res.headers['y-file-size']) return Promise.reject('response headers missing y-file-size');
    return {
      bytes: data,
      hash,
      fileSize: Number(res.headers['y-file-size'])
    }
  } catch(e) {
    return Promise.reject(e);
  }
}