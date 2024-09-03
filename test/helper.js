
import fs from "fs";
const crypto = require('crypto');
const log = require('loglevel');

function calculateMD5(filePath) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        const hash = crypto.createHash('md5');

        stream.on('data', chunk => {
            hash.update(chunk, 'utf8');
        });

        stream.on('error', err => {
            reject(err);
        });

        stream.on('end', () => {
            const md5 = hash.digest('hex');
            resolve(md5);
        });
    });
}
const key_pair = {
    private_key:
      "60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8",
    public_key:
      "731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca",
};

function generateFileWithSize(fp, size){
  let b = Buffer.alloc(1024 * 64);
  for(let i = 0; i < 1024 * 64; i++){
    b[i] = i%256
  }

  for (let i = 0; i < size/(1024 * 64); i++) {
    fs.writeFileSync(fp,
      b,
      {
        flag: "a+",
        mode: 0o666
      });
  }

  log.info("done generate file")
}

const tusConfig = {
  // tus服务，下载文件url
  downloadUrl: 'http://localhost:1080/get-seal-file-stream',
  // 使用tus服务时，加密文件写入的目录
  tusFileDir: '/tus-node-server/files'
}

export {
  calculateMD5,
  key_pair,
  generateFileWithSize,
  tusConfig
}
