// Browser wrapper for bytebuffer to provide default export and named LITTLE_ENDIAN
import BBPkg from 'https://esm.sh/bytebuffer@5.0.1?target=es2020';
const ByteBuffer = BBPkg.default || BBPkg;
const LITTLE_ENDIAN = ByteBuffer.LITTLE_ENDIAN;
export { LITTLE_ENDIAN };
export default ByteBuffer;
