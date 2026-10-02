/**
 * The texture formats a spray can be stored in, with what the planner and the VTF header
 * need to know about each. All three were confirmed working for sprays in TF2.
 */
import {flagEightBitAlpha, flagOneBitAlpha, imageFormatBGRA8888, imageFormatDXT1, imageFormatDXT5} from "./vtf.js";

export const formatDXT1 = "dxt1";
export const formatDXT5 = "dxt5";
export const formatBGRA8888 = "bgra8888";

const blocks = (width, height) => Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4));

export const textureFormats = {
    // 4 bits per texel, alpha either on or off.
    [formatDXT1]: {vtf: imageFormatDXT1, alphaFlag: flagOneBitAlpha, size: (w, h) => blocks(w, h) * 8, label: "DXT1"},
    // 8 bits per texel, with 8-bit alpha for soft edges.
    [formatDXT5]: {vtf: imageFormatDXT5, alphaFlag: flagEightBitAlpha, size: (w, h) => blocks(w, h) * 16, label: "DXT5"},
    // 32 bits per texel: exact colour and alpha, uncompressed.
    [formatBGRA8888]: {vtf: imageFormatBGRA8888, alphaFlag: flagEightBitAlpha, size: (w, h) => w * h * 4, label: "BGRA8888"},
};
