import { Buffer } from 'buffer';
const YPCNtObject = function() {
  if (!(this instanceof YPCNtObject)) {
    return new YPCNtObject();
  }

  this.getValueType = function(value) {
    const type = typeof value;
    let text = "";
    switch (type) {
      case "number":
        if ((value + "").includes(".")) {
          text = "double";
        } else {
          text = "int64_t";
        }
        break;
      case "bigint":
        text = "double";
        break;
      case "boolean":
        text = "bool";
        break;
      case value instanceof ArrayBuffer:
      case value instanceof Buffer:
        text = "bytes";
        break;
      default:
        text = "string";
        break;
    }
    return text;
  }

  this.autoGenerateBytes = function(line = []) {
    let input = [];
    for (let i = 0; i < line.length; i++) {
      let obj = {
        type: this.getValueType(line[i]),
        value: line[i],
      };
      input.push(obj);
    }

    return (input.length && this.generateBytes(input)) || undefined;
  }

  //input should be an array, which like
  //[{"type":"bool", "value": true},
  // {"type":"int8", "value":120},
  // {"type":"bytes", "value":0xdadfdfdfdfd}]
  this.generateBytes = function(input) {
    let length = this.getLengthOf(input);
    let buffer = Buffer.alloc(length);
    var inputLength = input.length;
    let offset = 4;
    for (var i = 0; i < inputLength; i++) {
      let d = input[i];
      let v = d["value"];

      switch (d["type"]) {
        case "bool":
          buffer.writeInt8(d["value"] == true ? 1 : 0, offset);
          offset += 1;
          break;
        case "uint8_t":
          buffer.writeUint8(v, offset);
          offset += 1;
          break;
        case "int8_t":
          buffer.writeInt8(v, offset);
          offset += 1;
          break;
        case "int16_t":
          buffer.writeInt16LE(v, offset);
          offset += 2;
          break;
        case "uint16_t":
          buffer.writeUint16LE(v, offset);
          offset += 2;
          break;
        case "int32_t":
          buffer.writeInt32LE(v, offset);
          offset += 4;
          break;
        case "uint32_t":
          buffer.writeUInt32LE(v, offset);
          offset += 4;
          break;
        case "int64_t":
          if (v < 0x7fffffff) {
            buffer.writeInt32LE(v, offset);
          } else {
            buffer.writeBigInt64LE(BigInt(v), offset);
          }
          //buffer.writeInt64(v, offset)
          offset += 8;
          break;
        case "uint64_t":
          if (v < 0xffffffff) {
            buffer.writeUInt32LE(v, offset);
          } else {
            buffer.writeBigUint64LE(BigInt(v), offset);
          }
          //buffer.writeUint16(v, offset)
          offset += 8;
          break;
        case "float":
          buffer.writeFloatLE(v, offset);
          offset += 4;
          break;
        case "double":
          buffer.writeDoubleLE(v, offset);
          offset += 8;
          break;
        case "string":
          var byteLen = Buffer.byteLength(v, "utf8");
          if (byteLen < 0xffffffff) {
            buffer.writeUInt32LE(byteLen, offset);
          } else {
            buffer.writeBigUint64LE(BigInt(byteLen), offset);
          }
          //buffer.writeUint64(byteLen, offset)
          offset += 8;
          //buffer.writeString(v, offset)
          buffer.write(v, offset);
          offset += byteLen;
          break;
        case "bytes":
          if (v.length < 0xffffffff) {
            buffer.writeUInt32LE(v.length, offset);
          } else {
            buffer.writeBigUint64LE(BigInt(v.length), offset);
          }
          //buffer.writeUint64(v.length, offset)
          offset += 8;
          v.copy(buffer, offset, 0, v.length);
          //buffer.append(v, offset)
          offset += v.length;
          break;
      }
    }
    return buffer;
  };

  this.getLengthOf = function(input) {
    var c = 4;
    var inputLength = input.length;
    for (var i = 0; i < inputLength; i++) {
      let d = input[i];
      let l = 0;
      switch (d["type"]) {
        case "bool":
          l = 1;
          break;
        case "uint8_t":
          l = 1;
          break;
        case "int8_t":
          l = 1;
          break;
        case "int16_t":
          l = 2;
          break;
        case "uint16_t":
          l = 2;
          break;
        case "int32_t":
          l = 4;
          break;
        case "uint32_t":
          l = 4;
          break;
        case "int64_t":
          l = 8;
          break;
        case "uint64_t":
          l = 8;
          break;
        case "float":
          l = 4;
          break;
        case "double":
          l = 8;
          break;
        case "string":
          var byteLen = Buffer.byteLength(d["value"], "utf8");
          l = 8 + byteLen;
          break;
        case "bytes":
          l = 8 + d["value"].length;
          break;
      }
      c = c + l;
    }
    return c;
  };
};

export default YPCNtObject;
