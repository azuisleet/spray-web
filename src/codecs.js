// Encoding and decoding for each texture format, by the names in textureFormats.js.
import {decodeDXT1, encodeDXT1} from "./dxt1.js";
import {decodeDXT5, encodeDXT5} from "./dxt5.js";
import {formatBGR888, formatBGRA8888, formatDXT1, formatDXT5} from "./textureFormats.js";

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

// RGBA to BGR, alpha dropped, and back as opaque.
function toBGR(source) {
    const out = new Uint8Array(source.length / 4 * 3);
    for (let i = 0, o = 0; i < source.length; i += 4, o += 3) {
        out[o] = source[i + 2];
        out[o + 1] = source[i + 1];
        out[o + 2] = source[i];
    }
    return out;
}

function fromBGR(source) {
    const out = new Uint8Array(source.length / 3 * 4);
    for (let i = 0, o = 0; i < source.length; i += 3, o += 4) {
        out[o] = source[i + 2];
        out[o + 1] = source[i + 1];
        out[o + 2] = source[i];
        out[o + 3] = 255;
    }
    return out;
}

export const codecs = {
    // Levels that are already RGBA, as when viewing a VTF read from a file.
    decoded: {encode: (width, height, rgba) => rgba, decode: (width, height, rgba) => rgba},
    [formatDXT1]: {encode: encodeDXT1, decode: decodeDXT1},
    [formatDXT5]: {encode: encodeDXT5, decode: decodeDXT5},
    [formatBGRA8888]: {encode: (width, height, rgba) => swapRedBlue(rgba), decode: (width, height, data) => swapRedBlue(data)},
    [formatBGR888]: {encode: (width, height, rgba) => toBGR(rgba), decode: (width, height, data) => fromBGR(data)},
};
