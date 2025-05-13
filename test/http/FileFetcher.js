const http = require('http');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
import {Unsealer} from "../Unsealer.js";
const EventEmitter = require('events');

// 更新状态文件
function updateStatus(filePath, status) {
  fs.writeFileSync(filePath, JSON.stringify(status));
}

// 读取状态文件
function readStatus(filePath) {
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  }
  return { processedBytes: 0, processedItems:0 };
}

class FileFetcher extends EventEmitter{
  constructor(url, dest, statusFilePath, keyPair){
    super();
    this.url = url;
    this.dest = dest;
    this.statusFilePath = statusFilePath;
    this.keyPair = keyPair;
  }

  downloadAndUnseal() {
    const status = readStatus(this.statusFilePath);
    const options = new URL(this.url);
    options.headers = {
      'Range': `bytes=${status.processedBytes}-`
    };

    const request = http.get(options, (res) => {
      if (res.statusCode === 206 || res.statusCode === 200) {
        const fileStream = fs.createWriteStream(dest, { flags: 'a' });

        const progressHandler = (totalItem, readItem, processedBytes){
          status.processedBytes = processedBytes;
          status.processedItems = readItem;
          updateStatus(statusFilePath, status);
          this.emit("progress", totalItem, readItem);
        };
        const unsealStream = new Unsealer(keyPair,
          {
            processedItems:status.processedItems,
            processedBytes:status.processedBytes,
            progressHandler: progressHandler
          });

      // 错误处理
        unsealStream.on('error', (error) => {
          this.emit("error",`downloadAndUnseal, unseal stream error: ${error.message}`);
          fileStream.end();
        });

        fileStream.on('error', (error) => {
          this.emit("error", `downloadAndUnseal, file stream error: ${error.message}`);
        });

        res.on('error', (error) => {
          this.emit("error", `downloadAndUnseal, Response stream error: ${error.message}`);
        });

        res.pipe(unsealStream).pipe(fileStream);

        res.on('end', () => {
          fileStream.end();
          this.emit("end");
        });

      } else {
        this.emit("error", `Server responded with ${res.statusCode}`);
      }
    });

    request.on('error', (err) => {
      this.emit("error", `HTTP request error: ${err.message}`);
    });
  }
}

// 下载文件
const filePath = path.join(__dirname, 'downloaded_largefile.txt');
const statusFilePath = path.join(__dirname, 'download_status.json');
downloadFile('http://localhost:8000', filePath, statusFilePath);
