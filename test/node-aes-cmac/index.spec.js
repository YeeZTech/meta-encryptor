const index = require("../../src/node-aes-cmac/index.js");

describe("index (module entry point)", () => {
  describe("aesCmac(key, message, [options])", () => {
    it("performs the AES-CMAC algorithm", () => {
      const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
      const message = Buffer.from("6bc1bee22e409f96e93d7e117393172a", "hex");
      const result = index.aesCmac(key, message);
      expect(result).toBe("070a16b46b4d4144f79bdd9dd04a287c");
    });

    it("can take a buffer or string as the key", () => {
      const stringKey = "averysecretvalue";
      const bufferKey = Buffer.from(stringKey);
      const message = Buffer.from("some message");
      expect(index.aesCmac(stringKey, message)).toBe(
        index.aesCmac(bufferKey, message)
      );
    });

    it("can take a buffer or string as the message", () => {
      const key = "averysecretvalue";
      const stringMessage = "some message";
      const bufferMessage = Buffer.from(stringMessage);
      expect(index.aesCmac(key, stringMessage)).toBe(
        index.aesCmac(key, bufferMessage)
      );
    });

    it("returns a buffer as the response if options.returnAsBuffer == true", () => {
      const key = "k3Men*p/2.3j4abB";
      const message = "this|is|a|test|message";
      const options = { returnAsBuffer: true };
      const result = index.aesCmac(key, message, options);
      expect(Buffer.isBuffer(result)).toBeTruthy();
      expect(result.toString("hex")).toBe("0125c538f8be7c4eea370f992a4ffdcb");
    });

    it("throws an error if the key length is invalid", () => {
      expectAesCmacError(
        "key",
        "some message",
        "Keys must be 128, 192, or 256 bits in length."
      );
    });

    it("throws an error if the key is neither Buffer nor string", () => {
      const expected = "Keys must be provided as a Buffer or string.";
      expectAesCmacError(null, "any message", expected);
      expectAesCmacError(123, "any message", expected);
    });

    it("throws an error if the message is neither string nor Buffer", () => {
      const expected = "The message must be provided as a string or Buffer.";
      expectAesCmacError("averysecretvalue", null, expected);
      expectAesCmacError("averysecretvalue", {}, expected);
    });
  });
});

function expectAesCmacError(key, message, expectedErrorMessage) {
  expect(() => {
    index.aesCmac(key, message);
  }).toThrow(expectedErrorMessage);
}
