import { aesCmac } from "./lib/aes-cmac.js";

const _aesCmac = function (key, message, options) {
  validateKey(key);
  var messageBuffer = validateMessage(message);
  options = options ? options : {};
  var result = aesCmac(key, messageBuffer);
  return options.returnAsBuffer ? result : result.toString("hex");
};
export { _aesCmac as aesCmac };

function validateKey(key) {
  if (typeof key !== "string" && !(key instanceof Buffer)) {
    throw new Error("Keys must be provided as a Buffer or string.");
  }
}

function validateMessage(message) {
  if (typeof message !== "string" && !(message instanceof Buffer)) {
    throw new Error("The message must be provided as a string or Buffer.");
  }
  return Buffer.isBuffer(message) ? message : Buffer.from(message);
}
