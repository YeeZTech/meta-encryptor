const fs = require("fs");
const path = require("path");
const os = require("os");
const { PipelineContextInFile } = require("../src/node/PipelineConext.js");

function tmpPath(name) {
  return path.join(os.tmpdir(), `me-pctx-${name}-${process.pid}-${Date.now()}`);
}

describe("PipelineContextInFile atomic replace", () => {
  let contextPath;
  let renameSpy;
  let copySpy;

  beforeEach(() => {
    contextPath = tmpPath("ctx.dat");
  });

  afterEach(() => {
    renameSpy?.mockRestore();
    copySpy?.mockRestore();
    for (const p of [contextPath, `${contextPath}.tmp`]) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
  });

  it("retries rename on EPERM then succeeds", async () => {
    let attempts = 0;
    const originalRename = fs.promises.rename.bind(fs.promises);
    renameSpy = jest.spyOn(fs.promises, "rename").mockImplementation(async (src, dst) => {
      attempts += 1;
      if (attempts <= 2) {
        const err = new Error("EPERM: operation not permitted, rename");
        err.code = "EPERM";
        throw err;
      }
      return originalRename(src, dst);
    });

    const pc = new PipelineContextInFile(contextPath);
    pc.update("readStart", 42);
    await pc.saveContext();

    expect(attempts).toBeGreaterThan(2);
    expect(fs.existsSync(contextPath)).toBe(true);
    expect(fs.existsSync(`${contextPath}.tmp`)).toBe(false);

    const loaded = new PipelineContextInFile(contextPath);
    await loaded.loadContext();
    expect(loaded.context.readStart).toBe(42);
  });

  it("falls back to copy+unlink when rename keeps failing with EPERM", async () => {
    renameSpy = jest.spyOn(fs.promises, "rename").mockImplementation(async () => {
      const err = new Error("EPERM: operation not permitted, rename");
      err.code = "EPERM";
      throw err;
    });

    const pc = new PipelineContextInFile(contextPath);
    pc.update("info", { stage: "decrypt" });
    await pc.saveContext();

    expect(fs.existsSync(contextPath)).toBe(true);
    expect(fs.existsSync(`${contextPath}.tmp`)).toBe(false);

    const loaded = new PipelineContextInFile(contextPath);
    await loaded.loadContext();
    expect(loaded.context.info).toEqual({ stage: "decrypt" });
  });

  it("throws after rename retries and copy fallback both fail", async () => {
    renameSpy = jest.spyOn(fs.promises, "rename").mockImplementation(async () => {
      const err = new Error("EPERM: operation not permitted, rename");
      err.code = "EPERM";
      throw err;
    });
    copySpy = jest.spyOn(fs.promises, "copyFile").mockImplementation(async () => {
      const err = new Error("EPERM: operation not permitted, copy");
      err.code = "EPERM";
      throw err;
    });

    const pc = new PipelineContextInFile(contextPath);
    pc.update("readStart", 1);

    await expect(pc.saveContext()).rejects.toMatchObject({ code: "EPERM" });
  });
});
