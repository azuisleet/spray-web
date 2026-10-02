/**
 * Reads VTF files (versions 7.1 to 7.5) made by this app or anything else, decoding every
 * mip level and frame to RGBA, and checks them against what is known to work as a spray.
 *
 * Layout, from the SDK's public/vtf/vtf.h: a header, then (7.1, 7.2) an optional low
 * resolution thumbnail and the image data straight after it, or (7.3 and later) a table
 * of resources at 0x50 giving where the image data starts. Image data runs from the
 * smallest mip level to the largest; within a level, every frame, then every face, then
 * every depth slice.
 */
import {decodeDXT1} from "./dxt1.js";
import {decodeDXT3, decodeDXT5} from "./dxt5.js";

export const uploadLimit = 512 * 1024;

const flagPointSample = 0x0001;
const flagEnvMap = 0x4000;

// Readable names for the header flags, from CompiledVtfFlags in vtf.h.
const flagNames = [
    [0x0001, "point sample"], [0x0002, "trilinear"], [0x0004, "clamp S"], [0x0008, "clamp T"],
    [0x0010, "anisotropic"], [0x0020, "DXT5 hint"], [0x0040, "sRGB"], [0x0080, "normal map"],
    [0x0100, "no mips"], [0x0200, "no LOD"], [0x0400, "all mips"], [0x0800, "procedural"],
    [0x1000, "1-bit alpha"], [0x2000, "8-bit alpha"], [0x4000, "environment map"],
    [0x8000, "render target"],
];

export function describeFlags(flags) {
    const names = flagNames.filter(([bit]) => flags & bit).map(([, name]) => name);
    const unknown = flags & ~flagNames.reduce((all, [bit]) => all | bit, 0);
    if (unknown) names.push(`0x${unknown.toString(16)}`);
    return names;
}

const blocks = (w, h) => Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4));

// An uncompressed format: bytes per pixel and how one pixel at data[p] becomes RGBA.
function uncompressed(bytesPerPixel, toRGBA) {
    return {
        size: (w, h) => w * h * bytesPerPixel,
        decode: (w, h, data) => {
            const out = new Uint8Array(w * h * 4);
            for (let i = 0, p = 0; i < w * h; i++, p += bytesPerPixel) out.set(toRGBA(data, p), i * 4);
            return out;
        },
    };
}

const u16 = (data, p) => data[p] | (data[p + 1] << 8);
const scale5 = (v) => (v << 3) | (v >> 2);
const scale6 = (v) => (v << 2) | (v >> 4);
const scale4 = (v) => v * 17;

// By the numbers in ImageFormat, public/bitmap/imageformat.h. confirmed marks the formats
// shown to work as sprays in TF2 (scripts/test-sprays.mjs).
export const vtfFormats = {
    0: {name: "RGBA8888", ...uncompressed(4, (d, p) => [d[p], d[p + 1], d[p + 2], d[p + 3]])},
    1: {name: "ABGR8888", ...uncompressed(4, (d, p) => [d[p + 3], d[p + 2], d[p + 1], d[p]])},
    2: {name: "RGB888", ...uncompressed(3, (d, p) => [d[p], d[p + 1], d[p + 2], 255])},
    3: {name: "BGR888", ...uncompressed(3, (d, p) => [d[p + 2], d[p + 1], d[p], 255])},
    4: {name: "RGB565", ...uncompressed(2, (d, p) => { const v = u16(d, p); return [scale5(v & 31), scale6((v >> 5) & 63), scale5(v >> 11), 255]; })},
    5: {name: "I8", ...uncompressed(1, (d, p) => [d[p], d[p], d[p], 255])},
    6: {name: "IA88", ...uncompressed(2, (d, p) => [d[p], d[p], d[p], d[p + 1]])},
    8: {name: "A8", ...uncompressed(1, (d, p) => [0, 0, 0, d[p]])},
    11: {name: "ARGB8888", ...uncompressed(4, (d, p) => [d[p + 1], d[p + 2], d[p + 3], d[p]])},
    12: {name: "BGRA8888", confirmed: true, ...uncompressed(4, (d, p) => [d[p + 2], d[p + 1], d[p], d[p + 3]])},
    13: {name: "DXT1", confirmed: true, size: (w, h) => blocks(w, h) * 8, decode: decodeDXT1},
    14: {name: "DXT3", size: (w, h) => blocks(w, h) * 16, decode: decodeDXT3},
    15: {name: "DXT5", confirmed: true, size: (w, h) => blocks(w, h) * 16, decode: decodeDXT5},
    16: {name: "BGRX8888", ...uncompressed(4, (d, p) => [d[p + 2], d[p + 1], d[p], 255])},
    17: {name: "BGR565", ...uncompressed(2, (d, p) => { const v = u16(d, p); return [scale5(v >> 11), scale6((v >> 5) & 63), scale5(v & 31), 255]; })},
    18: {name: "BGRX5551", ...uncompressed(2, (d, p) => { const v = u16(d, p); return [scale5((v >> 10) & 31), scale5((v >> 5) & 31), scale5(v & 31), 255]; })},
    19: {name: "BGRA4444", ...uncompressed(2, (d, p) => { const v = u16(d, p); return [scale4((v >> 8) & 15), scale4((v >> 4) & 15), scale4(v & 15), scale4(v >> 12)]; })},
    20: {name: "DXT1 with 1-bit alpha", confirmed: true, size: (w, h) => blocks(w, h) * 8, decode: decodeDXT1},
    21: {name: "BGRA5551", ...uncompressed(2, (d, p) => { const v = u16(d, p); return [scale5((v >> 10) & 31), scale5((v >> 5) & 31), scale5(v & 31), v & 0x8000 ? 255 : 0]; })},
};

// Resource tag for the image data in 7.3+ files (VTF_LEGACY_RSRC_IMAGE).
const imageResource = 0x30;

const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0;

/**
 * @param buffer ArrayBuffer or Uint8Array of the whole file
 * @returns {version, width, height, flags, flagNames, frames, mipCount, format,
 *           formatName, fileSize, pointSample, levels, checks}, where levels[level][frame]
 *           is RGBA and checks is [{severity: "error" | "warning" | "info", text}].
 *           With an error, levels is empty.
 */
export function readVTF(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const checks = [];
    const fail = (text, partial = {}) => ({levels: [], checks: [...checks, {severity: "error", text}], fileSize: bytes.length, ...partial});

    if (bytes.length < 64 || String.fromCharCode(...bytes.subarray(0, 4)) !== "VTF\0") return fail("This is not a VTF file.");
    const major = view.getUint32(4, true);
    const minor = view.getUint32(8, true);
    const version = `${major}.${minor}`;
    if (major !== 7 || minor > 5) return fail(`VTF version ${version} is not one this can read (7.0 to 7.5).`, {version});

    const headerSize = view.getUint32(12, true);
    const width = view.getUint16(16, true);
    const height = view.getUint16(18, true);
    const flags = view.getUint32(20, true);
    const frames = Math.max(1, view.getUint16(24, true));
    const firstFrame = view.getUint16(26, true);
    const format = view.getInt32(0x34, true);
    const mipCount = Math.max(1, bytes[0x38]);
    const lowResFormat = view.getInt32(0x39, true);
    const lowResWidth = bytes[0x3D];
    const lowResHeight = bytes[0x3E];
    const depth = minor >= 2 ? Math.max(1, view.getUint16(0x3F, true)) : 1;

    const info = {
        version, width, height, flags, flagNames: describeFlags(flags), frames, mipCount, format,
        formatName: vtfFormats[format]?.name ?? `format ${format}`, fileSize: bytes.length,
        pointSample: (flags & flagPointSample) !== 0,
    };

    if (flags & flagEnvMap) return fail("This is a cube map (environment map), not a spray.", info);
    if (depth > 1) return fail("This is a volume texture, not a spray.", info);
    const codec = vtfFormats[format];
    if (!codec) return fail(`It is stored in ${info.formatName}, which this cannot display.`, info);

    // Where the image data starts.
    let dataStart = headerSize;
    if (minor >= 3) {
        const resources = view.getUint32(0x44, true);
        let found = null;
        for (let i = 0; i < resources; i++) {
            const entry = 0x50 + i * 8;
            if (entry + 8 > bytes.length) break;
            if (bytes[entry] === imageResource && bytes[entry + 1] === 0 && bytes[entry + 2] === 0) found = view.getUint32(entry + 4, true);
        }
        if (found === null) return fail("The file lists no image data.", info);
        dataStart = found;
    } else if (lowResFormat !== -1 && lowResWidth && lowResHeight && vtfFormats[lowResFormat]) {
        dataStart += vtfFormats[lowResFormat].size(lowResWidth, lowResHeight);
    }

    // Mip levels are stored smallest first; walk them to find each one's offset.
    const dims = Array.from({length: mipCount}, (_, level) => [Math.max(1, width >> level), Math.max(1, height >> level)]);
    const levelOffsets = [];
    let offset = dataStart;
    for (let level = mipCount - 1; level >= 0; level--) {
        levelOffsets[level] = offset;
        offset += codec.size(...dims[level]) * frames;
    }
    if (offset > bytes.length) return fail("The file is shorter than its header says: it is cut off or damaged.", info);

    const levels = dims.map(([w, h], level) => Array.from({length: frames}, (_, frame) => {
        const start = levelOffsets[level] + frame * codec.size(w, h);
        return codec.decode(w, h, bytes.subarray(start, start + codec.size(w, h)));
    }));

    // Checks against what is known about sprays.
    if (bytes.length > uploadLimit) {
        checks.push({severity: "warning", text: `At ${bytes.length.toLocaleString()} bytes it is over TF2's 512 KB limit, so it will not upload. Convert it to make it fit.`});
    }
    if (mipCount > 1 && !(isPowerOfTwo(width) && isPowerOfTwo(height))) {
        checks.push({severity: "warning", text: "It has mipmaps at a size that is not a power of two: TF2 draws those levels out of alignment."});
    }
    if (!codec.confirmed) {
        checks.push({severity: "warning", text: `Sprays in ${codec.name} have not been tested in TF2; DXT1, DXT5 and BGRA8888 are known to work.`});
    }
    if (width > 2048 || height > 2048) {
        checks.push({severity: "warning", text: "Sides over 2048 have not been tested in TF2."});
    }
    if (frames > 1) {
        checks.push({severity: "info", text: `${frames} frames play in ${(frames / 5).toFixed(1)} s at TF2's 5 frames a second${firstFrame ? `, starting from frame ${firstFrame + 1}` : ""}.`});
    }
    if (mipCount > 1) checks.push({severity: "info", text: `${mipCount} mip levels: the distance slider shows which TF2 draws as you walk away.`});
    if (info.pointSample) checks.push({severity: "info", text: "Point sampled: TF2 draws it unsmoothed, pixels sharp."});
    if (!checks.some(check => check.severity === "warning")) checks.unshift({severity: "info", text: "Nothing stops this working as a spray."});

    return {...info, levels, checks};
}
