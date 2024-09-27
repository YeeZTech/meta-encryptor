import { ProgressInfoStream }from "../src/ProgressInfoStream.js"
import { UnsealerWithProgressInfo }from "../src/UnsealerWithProgressInfo.js"
import { EventEmitter } from "events";
import axios from "axios";

const log = require("loglevel").getLogger("meta-encryptor/UnsealerWithTus");

export class UnsealerWithTus {
  constructor(options) {
    this._eventEmitter = new EventEmitter();
    this._isAbort = false;
    this._options = options;
    
    this._writeStream = new ProgressInfoStream({
      filePath: this._options.filePath,
      progressFilePath: this._options.progressFilePath,
    });
    
    this._writeStream.on('progressInfoAvailable', (res) => {
      log.debug('progressInfoAvailable', res)
      this._lastProgressInfo = {
        processedBytes: res.processedBytes,
        readItemCount: res.readItemCount,
        writeSucceedBytes: res.writeSucceedBytes,
      };
    })
  }
  _start() {
    this._inputStream?.on("close", (e) => {
      log?.info("[DecryptorWithHttp] inputStream close e", e);
    });
    this._inputStream?.on("end", () => {
      log?.info("[DecryptorWithHttp] inputStream end");
    });
    this._inputStream?.on("error", (e) => {
      log?.info("[DecryptorWithHttp] inputStream error", e);
      this._emit("error", e);
    });
    this._unSealerTransform.on("end", () => {
      log?.info("[DecryptorWithHttp] unSealerTransform end");
    });
    this._unSealerTransform.on("error", (e) => {
      log?.info("[DecryptorWithHttp] unSealerTransform error", e);
      this._emit("error", e);
    });

    this._writeStream.on(
      "progress",
      (processedBytes, readItemCount, totalItem, writeSucceedBytes) => {
        this._progressHandler(
          totalItem,
          readItemCount,
          processedBytes,
          writeSucceedBytes
        );
      }
    );
    this._writeStream.on("close", () => {
      log?.info("[DecryptorWithHttp] writeStream close this._isAbort", this._isAbort);
      !this._isAbort && this._emit("close");
    });
    this._writeStream.on("error", (e) => {
      log?.info("[DecryptorWithHttp] writeStream close");
      this._emit("error", e);
    });
    this._inputStream?.pipe(this._unSealerTransform).pipe(this._writeStream);
  }
  async _createdInputStream() {
    try {
      const request = axios.create({
        withCredentials: false,
        timeout: this._options.timeout,
      });
      const res = await request.get(
        this._options.getSealedFileStreamServerUrl,
        {
          params: {
            fileName: this._options.sealedFileName,
            start: this._lastProgressInfo.processedBytes,
          },
          responseType: "stream",
        }
      );
      this._inputStream = res.data;
    } catch (e) {
      this._emit("error", e);
    }
  }
  _progressHandler(
    totalItem,
    readItem,
    bytes,
    writeBytes
  ) {
    this._lastProgressInfo.processedBytes = bytes;
    this._lastProgressInfo.processedItems = readItem;
    this._lastProgressInfo.writeBytes = writeBytes;
    this._emit("progress", {
      totalItem,
      readItem,
      bytes,
      writeBytes,
    });
  }
  _emit(event, ...args) {
    this._eventEmitter.emit(event, ...args);
  }
  on(event, listener) {
    this._eventEmitter.on(event, listener);
    return this;
  }
  async abort() {
    this._isAbort = true;
    log?.info("this._inputStream?.destroyed", this._inputStream?.destroyed);
    this._writeStream?.destroy();
    this._inputStream?.destroy();
    this._unSealerTransform?.destroy();
    this._inputStream?.unpipe();
    return this._lastProgressInfo;
  }
  async start() {
    await this._writeStream.initialize();
    await this._createdInputStream();
    this._unSealerTransform = new UnsealerWithProgressInfo({
      keyPair: {
        private_key: this._options.privateKey,
        public_key: this._options.publicKey,
      },
      processedItemCount: this._lastProgressInfo.readItemCount,
      processedBytes: this._lastProgressInfo.processedBytes,
      writeBytes: this._lastProgressInfo.writeSucceedBytes,
    });
    this._start();
  }
}
