const meta = require("../src/index.node.js");
const {PipelineContextInFile} = require("../src/node/PipelineConext.js")
import fs from "fs";
import { testPath } from "./helper";


test('test pipeline context basic', async ()=>{
    var filePath = "pipeline_context"
    var pc = new PipelineContextInFile(filePath)
    pc.context["readStart"] = 124;
    pc.update('data', Buffer.from('Hello, World!'));
    pc.update('info', { name: 'Test' });
    try {
        await pc.saveContext();
        console.log('上下文保存成功');

        const newContext = new PipelineContextInFile(filePath);
        await newContext.loadContext();
        console.log('上下文加载成功:', newContext.context);
        expect(newContext.context["data"].compare(Buffer.from('Hello, World!'))).toBe(0)
        expect(newContext.context["readStart"]).toBe(124);
    } catch (error) {
        console.error('操作出错:', error.message);
    } finally{
        fs.unlinkSync(filePath);
    }
})

test('context save queue recovers after a failed write', async () => {
    const filePath = testPath('pipeline_context_retry');
    const pc = new PipelineContextInFile(filePath);
    const writeAtomic = pc._writeContextAtomic.bind(pc);
    let attempts = 0;

    pc._writeContextAtomic = async () => {
        attempts += 1;
        if (attempts === 1) {
            throw new Error('injected context write failure');
        }
        return writeAtomic();
    };

    pc.context.value = 'first';
    await expect(pc.saveContext()).rejects.toThrow('injected context write failure');

    pc.context.value = 'latest';
    await expect(pc.saveContext()).resolves.toBeUndefined();

    const loaded = new PipelineContextInFile(filePath);
    await loaded.loadContext();
    expect(loaded.context.value).toBe('latest');
    expect(attempts).toBe(2);
});

test('Uint8Array context data round-trips as exact binary bytes', async () => {
    const filePath = testPath('pipeline_context_uint8array');
    const pc = new PipelineContextInFile(filePath);
    const backing = Uint8Array.from([0xff, 0x01, 0x02, 0x03, 0xee]);

    pc.context.data = new Uint8Array(backing.buffer, 1, 3);
    await pc.saveContext();

    const loaded = new PipelineContextInFile(filePath);
    await loaded.loadContext();
    expect(Buffer.isBuffer(loaded.context.data)).toBe(true);
    expect([...loaded.context.data]).toEqual([0x01, 0x02, 0x03]);
});

