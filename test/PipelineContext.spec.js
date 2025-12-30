const meta = require("../src/index.node.js");
const {PipelineContextInFile} = require("../src/PipelineConext.js")
import fs from "fs";


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

