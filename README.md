# meta-encryptor

**中文** | [English](./README.en.md)

#### 介绍

在[典枢](https://doc-dianshu.yeez.tech/index.php)的流程中，用户需要托管数据，供[Fidelius](https://github.com/YeeZTech/YeeZ-Privacy-Computing)解密、计算保证数据的正确性和隐私性，但是，用户不希望暴露源数据。因此，用户需要在本地完成加密，同样的，用户获得数据时，需要在本地进行解密（注意，此处的本地可以是网页，也可以是客户端）。meta-encryptor 就是提供给用户的加解密工具。

#### 软件架构

使用 crypto 等加密算法。

#### 安装教程

npm

```base
npm install @yeez-tech/meta-encryptor --save
```

yarn

```base
yarn add @yeez-tech/meta-encryptor
```

#### 构建及测试

```base
yarn install
yarn test
```

#### API

##### crypto.generatePrivateKey

生成私钥

```js
import {crypto} from '@yeez-tech/meta-encryptor';

const sKey = crypto.generatePrivateKey();

console.log('私钥=', sKey);
const pKey = meta.crypto.generatePublicKeyFromPrivateKey(sKey);
useStore().commit(ConfigMutationTypes.SET_ENCRYPTION_CONFIG, {
    privateKey: sKey.toString('hex'),
    publicKey: pKey.toString('hex')
});
const ypcName = meta.crypto.generateFileNameFromPKey(pKey);
const ypcJson = meta.crypto.generateFileContentFromSKey(sKey);
```

##### crypto.generatePublicKeyFromPrivateKey

通过私钥生成公钥

```js
import {crypto} from '@yeez-tech/meta-encryptor';
const pKey = crypto.generatePublicKeyFromPrivateKey(sKey);
console.log('公钥钥=', pKey);
```

##### crypto.generateFileNameFromPKey

通过公钥生成文件名

```js
import {crypto} from '@yeez-tech/meta-encryptor';
const ypcName = crypto.generateFileNameFromPKey(pKey);
console.log('文件名=', ypcName);
```

##### crypto.generateFileContentFromSKey

通过私钥获取密钥文件内容

```js
import {crypto} from '@yeez-tech/meta-encryptor';
const ypcJson = crypto.generateFileContentFromSKey(sKey);
console.log('文件内容=', ypcJson);
```

##### Sealer

推荐使用 Sealer 加密流，该方法支持多种格式，包括 CSV，Excel，下面是对 CSV 的例子，其中使用了`ToString`将`csv()`产生的对象转换为`Buffer`。

```js
import {Sealer, ToString} from "@yeez-tech/meta-encryptor"

let rs = fs.createReadStream(src)
let ws = fs.createWriteStream(dst)

rs.pipe(csv())
  .pipe(new ToString())
  .pipe(new Sealer({keyPair:key_pair))
  .pipe(ws);
```

##### Unsealer

Unsealer 用来解密流，并且将结果输出到流.

```js
import {Sealer, Unsealer, SealedFileStream} from '@yeez-tech/meta-encryptor';

/*
let src = "./tsconfig.json"
let dst = "./tsconfig.json.encrypted";
let rs = fs.createReadStream(src)
let ws = fs.createWriteStream(dst)

rs.pipe(csv())
  .pipe(new Sealer({keyPair:key_pair))
  .pipe(ws);
await new Promise(resolve=>{
  ws.on('finish', ()=>resolve());
});
*/

let unsealer = new Unsealer({keyPair: key_pair});
let rrs = new SealedFileStream(dst);
let wws = fs.createWriteStream(src + '.new');

rrs.pipe(unsealer).pipe(wws);
await new Promise((resolve) => {
    wws.on('finish', () => resolve());
});
```

##### isSealedFile

用于判断一个文件是否为一个有效的封装文件，如果为真，返回`true`，否则，返回`false`。

```js
import {isSealedFile} from '@yeez-tech/meta-encryptor';

let r = isSealedFile(path);
```

##### sealedFileVersion

返回封装文件的版本号。

```js
import {sealedFileVersion} from '@yeez-tech/meta-encryptor';

let r = sealedFileVersion(path);
```

##### dataHashOfSealedFile

返回封装文件对应的原始数据的 hash。注意，该函数直接读取的是记录在文件头的 hash，如果文件被篡改，该函数有可能返回错误的 hash，因此，如果有可能，应该在解密之后，对 hash 进行校验。

```js
import {dataHashOfSealedFile} from '@yeez-tech/meta-encryptor';

let r = dataHashOfSealedFile(path);
```

##### signedDataHash

对数据 hash 进行签名。

```js
import {signedDataHash} from '@yeez-tech/meta-encryptor';

//keyPair应该是{'private-key':'hex string of private key',
//dataHash应该是一个Buffer，长度为32字节
let r = signedDataHash(keyPair, dataHash);
```

##### forwardSkey

生成转发枢私钥的信息。

```js
import {forwardSkey} from '@yeez-tech/meta-encryptor';

//keyPair应该是{'private-key':'hex string of private key',
//dianPKey应该是一个Buffer，包含了典公钥，
//enclaveHash应该是一个Buffer，包含了keyMgr的hash，可以为null，如果为null，则意味着可以被转发到任意的enclave中；
let r = forwardSkey(keyPair, dianPKey, enclaveHash);
```

返回如下对象，

```js
{
  encrypted_skey:Buffer,
  forward_sig: Buffer
}
```

##### 可恢复流

meta-encryptor 提供了支持断点续传的可恢复流功能，主要包含以下组件：

###### RecoverableReadStream

用于支持断点续传的读取流，可以从指定位置恢复读取。

```js
import {RecoverableReadStream} from '@yeez-tech/meta-encryptor';

const context = new PipelineContextInFile('context.dat');
const readStream = new RecoverableReadStream('input.file', context);

readStream.pipe(someWriteStream);
```

###### RecoverableWriteStream

用于支持断点续传的写入流，可以从指定位置恢复写入。

```js
import {RecoverableWriteStream} from '@yeez-tech/meta-encryptor';

const context = new PipelineContextInFile('context.dat');
const writeStream = new RecoverableWriteStream('output.file', context);

someReadStream.pipe(writeStream);
```

###### PipelineContext

用于管理断点续传过程中的上下文信息的基类。

```js
import {PipelineContext} from '@yeez-tech/meta-encryptor';

class MyContext extends PipelineContext {
    saveContext() {
        // 实现保存上下文的逻辑
    }

    loadContext() {
        // 实现加载上下文的逻辑
    }
}
```

###### PipelineContextInFile

基于文件存储的上下文管理实现，支持二进制数据。

```js
import {PipelineContextInFile} from '@yeez-tech/meta-encryptor';

const context = new PipelineContextInFile('context.dat');

// 保存上下文
await context.saveContext();

// 加载上下文
await context.loadContext();
```

使用示例：

```js
import {RecoverableReadStream, RecoverableWriteStream, PipelineContextInFile} from '@yeez-tech/meta-encryptor';

// 创建上下文管理器
const context = new PipelineContextInFile('transfer.context');

// 创建可恢复的读写流
const readStream = new RecoverableReadStream('source.file', context);
const writeStream = new RecoverableWriteStream('target.file', context);

// 处理传输
readStream.pipe(writeStream);

// 如果传输中断，可以使用相同的上下文重新创建流来继续传输
const resumeReadStream = new RecoverableReadStream('source.file', context);
const resumeWriteStream = new RecoverableWriteStream('target.file', context);
resumeReadStream.pipe(resumeWriteStream);
```

这些类提供了可靠的断点续传功能，特别适用于大文件传输或需要支持中断恢复的场景。上下文信息会被自动保存，确保传输可以从中断点准确恢复。

##### 断点续传解密

meta-encryptor 支持将可恢复流与 Unsealer 结合使用，实现加密文件的断点续传解密功能。

```js
import {
    RecoverableReadStream,
    RecoverableWriteStream,
    PipelineContextInFile,
    Unsealer
} from '@yeez-tech/meta-encryptor';

// 创建上下文管理器
const context = new PipelineContextInFile('context.dat');
await context.loadContext();

// 创建解密管道
const readStream = new RecoverableReadStream(encryptedFile, context);
const unsealer = new Unsealer({
    keyPair,
    context,
    progressHandler: (totalItem, readItem, bytes, writeBytes) => {
        console.log(`Progress: ${(bytes / (1024 * 1024)).toFixed(2)}MB`);
    }
});
const writeStream = new RecoverableWriteStream(decryptedFile, context);

// 连接管道并处理事件
readStream.pipe(unsealer).pipe(writeStream);

// 如果需要暂停，可以断开管道并保存上下文
readStream.unpipe(unsealer);
unsealer.unpipe(writeStream);

// 之后可以使用相同的上下文重新创建管道继续解密
```

这种方式特别适用于大文件解密和需要断点续传的场景。系统会自动管理解密进度和上下文信息，确保可以从任意断点恢复解密过程

#### Author

contact@yeez.tech
