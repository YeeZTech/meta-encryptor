const bufferTools = require("../../src/node-aes-cmac/lib/buffer-tools.js");

describe("buffer-tools", () => {
  describe("bitShiftLeft", () => {
    function testBitShiftLeft(input) {
      return bufferTools
        .bitShiftLeft(Buffer.from(input, "hex"))
        .toString("hex");
    }

    it("returns a buffer bitshifted left 1 bit (buffer_value << 1)", () => {
      expect(testBitShiftLeft("01")).toBe("02");
      expect(testBitShiftLeft("02")).toBe("04");
      expect(testBitShiftLeft("04")).toBe("08");
      expect(testBitShiftLeft("08")).toBe("10");
      expect(testBitShiftLeft("10")).toBe("20");
      expect(testBitShiftLeft("20")).toBe("40");
      expect(testBitShiftLeft("40")).toBe("80");
      expect(testBitShiftLeft("80")).toBe("00");
      expect(testBitShiftLeft("55cc33")).toBe("ab9866");
    });
  });

  describe("xor", () => {
    function testXor(a, b) {
      return bufferTools
        .xor(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
        .toString("hex");
    }

    it("returns the logical XOR of two buffers", () => {
      expect(testXor("5a", "a5")).toBe("ff");
      expect(testXor("5a", "5a")).toBe("00");
      expect(testXor("5a", "ff")).toBe("a5");
      expect(testXor("5a", "00")).toBe("5a");
      expect(testXor("5a", "c3")).toBe("99");
      expect(testXor("5a", "99")).toBe("c3");
      expect(testXor("abcd", "0123")).toBe("aaee");
      expect(testXor("123456", "789abc")).toBe("6aaeea");
    });
  });

  describe("toBinaryString", () => {
    function testToBinaryString(input) {
      return bufferTools.toBinaryString(Buffer.from(input, "hex"));
    }

    it("returns the binary string representation of a buffer", () => {
      expect(testToBinaryString("0f")).toBe("00001111");
      expect(testToBinaryString("5ac3")).toBe("0101101011000011");
      expect(testToBinaryString("deadbeef")).toBe(
        "11011110101011011011111011101111"
      );
    });
  });
});
