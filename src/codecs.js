// Encoding and decoding for each texture format, by the names in textureFormats.js.
import {decodeDXT1, encodeDXT1} from "./dxt1.js";
import {decodeDXT5, encodeDXT5} from "./dxt5.js";
import {formatBGRA8888, formatDXT1, formatDXT5} from "./textureFormats.js";

// RGBA to the BGRA byte order the format is named for, and back.
function swapRedBlue(source) {
    const out = new Uint8Array(source.length);
    for (let i = 0; i < source.length; i += 4) {
        out[i] = source[i + 2];
        out[i + 1] = source[i + 1];
        out[i + 2] = source[i];
        out[i + 3] = source[i + 3];
    }
    return out;
}

export const codecs = {
    // Levels that are already RGBA, as when viewing a VTF read from a file.
    decoded: {encode: (width, height, rgba) => rgba, decode: (width, height, rgba) => rgba},
    [formatDXT1]: {encode: encodeDXT1, decode: decodeDXT1},
    [formatDXT5]: {encode: encodeDXT5, decode: decodeDXT5},
    [formatBGRA8888]: {encode: (width, height, rgba) => swapRedBlue(rgba), decode: (width, height, data) => swapRedBlue(data)},
};
