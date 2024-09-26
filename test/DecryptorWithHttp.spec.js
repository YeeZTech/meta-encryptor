import path from "path"
import fs from "fs"
import { uuidv7 } from 'uuidv7'
import { DecryptorWithHttp } from "../src/DecryptorWithHttp";
import { Sealer } from "../src/Sealer"
import { Writable } from "stream";
import{ calculateMD5, key_pair, generateFileWithSize, tusConfig } from "./helper"
import log from 'loglevel'

const logger = require("loglevel").getLogger("meta-encryptor/DecryptorWithHttp");

logger.setLevel('error')

log.setLevel('error')

const sealedFile = async (options) => {
  let rs = fs.createReadStream(options.filePath)
  let ws = fs.createWriteStream(options.encFilePath)
  rs.pipe(new Sealer({keyPair: key_pair})).pipe(ws)
  await new Promise((resolve)=>{
    ws.on('finish', ()=>{
      resolve();
    });
  });
}

class MockWriteStream extends Writable {
  constructor() {
    super();
    this.bytesWritten = 0;
    this.path = "";
    this.pending = false;
    this.shouldError = false;
  }
  close() {
    this.emit("close");
  }
  _write(chunk, encoding, callback) {
    this.bytesWritten += chunk.length;
    if (this.shouldError) {
      this.emit("error", new Error("ENOSPC: no space left on device"));
      this.end();
    } else {
      super.write(chunk, encoding, callback);
    }
  }
  simulateError() {
    this.shouldError = true;
  }
}

async function generateEncryptOptions(args) {
  const key = uuidv7();
  const fileName = args.fileName ? args.fileName : key + ".file";
  const filePath = path.join(__dirname, "../" + fileName);
  const processFilePath = path.join(__dirname, "../" + fileName + ".pro")
  const decryptFilePath = path.join(__dirname, "../decrypt_" + fileName);
  args.size && generateFileWithSize(filePath, args.size);
  // 生成加密文件名称
  const encFileName = `${key}_${Date.now()}.sealed`;
  // 生成加密文件路径
  const encFilePath = path.join(tusConfig.tusFileDir, encFileName);
  const options = {
    key,
    filePath,
    encFilePath,
    decryptFilePath,
    encFileName,
    processFilePath
  };
  return options;
}

const fileSizeList = [1024 * 1024 * 10];
const bigFileSizeList = [1024 * 1024 * 1024];
describe.skip("DecryptorWithHttp", () => {
  test.each(fileSizeList.map((size) => [size]))(
    "base DecryptorWithHttp %s",
    async (size) => {
      const options = await generateEncryptOptions({
        size,
      });
      await sealedFile({
        ...options,
      });
      const eventHandler = jest.fn();
      await new Promise((resolve, reject) => {
        const decryptorEx = new DecryptorWithHttp({
          privateKey: key_pair.private_key,
          publicKey: key_pair.public_key,
          filePath: options.decryptFilePath,
          processFilePath: options.processFilePath,
          sealedFileName: options.encFileName,
          getSealedFileStreamServerUrl: tusConfig.downloadUrl,
        });
        decryptorEx.on("error", (e) => {
          log.error("unSealer error", e);
          reject(e);
        });
        decryptorEx.on("close", () => {
          eventHandler();
          resolve(true);
        });
        decryptorEx.start();
      });
      const localHash = await calculateMD5(options.filePath);
      const decryptHash = await calculateMD5(options.decryptFilePath);
      expect(eventHandler).toHaveBeenCalledTimes(1);
      expect(localHash).toBeTruthy();
      expect(decryptHash).toBeTruthy();
      expect(localHash).toBe(decryptHash);
      fs.unlinkSync(options.filePath);
      fs.unlinkSync(options.encFilePath);
      fs.unlinkSync(options.decryptFilePath);
      fs.unlinkSync(options.processFilePath);
    }
  );
  test.each(bigFileSizeList.map((size) => [size]))(
    "pause and resume %s",
    async (size) => {
      const options = await generateEncryptOptions({
        size,
      });
      await sealedFile({
        ...options,
      });
      let keep = true;
      let status = { processedBytes: 0, processedItems: 0, writeBytes: 0 };
      while (keep) {
        const decryptorEx = new DecryptorWithHttp({
          privateKey: key_pair.private_key,
          publicKey: key_pair.public_key,
          filePath: options.decryptFilePath,
          processFilePath: options.processFilePath,
          sealedFileName: options.encFileName,
          getSealedFileStreamServerUrl: tusConfig.downloadUrl,
        });
        decryptorEx.on("close", () => {
          log.info("decryptorEx close");
          keep = false;
        });
        decryptorEx.on("error", (e) => {
          log.error("decryptorEx error", e);
        });
        await decryptorEx.start();
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve(true);
            clearTimeout(timer);
          }, 40);
        });
        status = keep && (await decryptorEx.abort());
        log.warn("status", status);
      }

      const localHash = await calculateMD5(options.filePath);
      const decryptHash = await calculateMD5(options.decryptFilePath);
      log.info("localHash", localHash);
      log.info("decryptHash", decryptHash);
      expect(localHash).toBeTruthy();
      expect(decryptHash).toBeTruthy();
      expect(localHash).toBe(decryptHash);
      fs.unlinkSync(options.filePath);
      fs.unlinkSync(options.encFilePath);
      fs.unlinkSync(options.decryptFilePath);
      fs.unlinkSync(options.processFilePath);
    }
  );
  test.skip("ENOSPC: no space left on device", async () => {
    const options = await generateEncryptOptions({
      size: 1024 * 1024 * 100,
    });
    await sealedFile({
      ...options,
    });
    // TODO: 由于没有使用createWriteStream，导致此用例不生效
    jest.spyOn(fs, "createWriteStream").mockImplementation(() => {
      const stream = new MockWriteStream();
      stream.simulateError();
      return stream;
    });
    const eventHandler = jest.fn();
    await new Promise((resolve) => {
      const decryptorEx = new DecryptorWithHttp({
        privateKey: key_pair.private_key,
        publicKey: key_pair.public_key,
        filePath: options.decryptFilePath,
        processFilePath: options.processFilePath,
        sealedFileName: options.encFileName,
        getSealedFileStreamServerUrl: tusConfig.downloadUrl,
      });
      decryptorEx.on("error", (e) => {
        eventHandler(e);
        resolve(e);
      });
      decryptorEx.start();
    });
    expect(eventHandler).toHaveBeenCalledTimes(1);
    expect(eventHandler.mock.calls[0][0].message).toBe(
      "ENOSPC: no space left on device"
    );
    fs.unlinkSync(options.filePath);
    fs.unlinkSync(options.encFilePath);
    fs.unlinkSync(options.processFilePath);
  });
});
