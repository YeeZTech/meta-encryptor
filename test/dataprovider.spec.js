const meta = require("../src/index.node.js");
const ByteBuffer = require("bytebuffer");
var streams = require('memory-streams');
import DP from "../src/DataProvider.js"
const {headerAndBlockBufferFromBuffer} = DP

const BlockNumLimit = 1024 * 1024;
import{key_pair} from "./helper"


test('test dataprovider basic', async ()=>{

  let dp = new meta.DataProvider(key_pair);

  let ds = new streams.WritableStream()

  let ntbytes = meta.YPCNtObject.autoGenerateBytes(["1", 2, 3, "2020/10/01"])
  dp.sealData(ntbytes, ds)
  const sealData = dp.sealData(null, ds, true);
  let expect_hash = sealData.data_hash;
  let b2 = ds.toBuffer();
  let all = b2
  //check data
  let ks = new streams.ReadableStream(all)
  let headerAndBlockBuffer = headerAndBlockBufferFromBuffer(all)
  expect(all.length < 32 * BlockNumLimit).toBeTruthy();

})

