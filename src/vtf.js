const imageFormatDXT1 = 13;
const dxt1BlockBytes = 8;

export const headerSize = 0x40;

const flagClampS = 0x0004;
const flagClampT = 0x0008;
export const flagNoMip = 0x0100;
const flagNoLod = 0x0200;
// vtex sets one of these from the texture data: ONEBITALPHA for 1-bit alpha like ours,
// EIGHTBITALPHA for anything finer. Test sprays with either flag, or neither, looked the
// same in TF2 (scripts/test-sprays.mjs), so the spray says what it actually holds.
export const flagOneBitAlpha = 0x1000;
export const flagEightBitAlpha = 0x2000;

// NOLOD keeps the texture out of the picmip/texture-quality path so a mip trick lands
// at the same distance for everyone. Valve sets NOMIP|NOLOD on every runtime-built
// UI texture in the SDK, so this pairing is the house style.
export const baseFlags = flagClampS | flagClampT | flagNoLod | flagOneBitAlpha;

// Budget for the DXT1 payload; the header fits in what is left of the 512 KB upload limit.
// A spray filling it exactly (1008x1040, 524,224 bytes with header) works in TF2, and
// 1024x1024 (524,352 bytes) does not fit.
export const maximumSize = (1024 * 512) - 0x80;

export function buildHeader(width, height, frames, mipCount, flags) {
    const header = new Uint8Array(headerSize);
    const view = new DataView(header.buffer);

    header.set([0x56, 0x54, 0x46, 0x00], 0x00);     // "VTF\0"
    view.setUint32(0x04, 7, true);                  // version major
    view.setUint32(0x08, 1, true);                  // version minor
    view.setUint32(0x0C, headerSize, true);
    view.setUint16(0x10, width, true);
    view.setUint16(0x12, height, true);
    view.setUint32(0x14, flags, true);
    view.setUint16(0x18, frames, true);
    view.setUint16(0x1A, 0, true);                  // first frame
    // 0x1C padding, 0x20 reflectivity[3], 0x2C padding, 0x30 bumpmap scale
    view.setUint32(0x34, imageFormatDXT1, true);    // high res image format
    view.setUint8(0x38, mipCount);
    view.setUint32(0x39, imageFormatDXT1, true);    // low res image format
    view.setUint8(0x3D, 0);                         // low res width, 0 = no thumbnail
    view.setUint8(0x3E, 0);                         // low res height
    view.setUint8(0x3F, 1);                         // pad out to headerSize

    return header;
}

// DXT1 never stores less than one 4x4 block, so the tail of the chain costs 8 bytes a level.
export function dxt1Size(width, height) {
    return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * dxt1BlockBytes;
}

export function mipDimensions(width, height) {
    const dimensions = [];
    for (let level = 0; ; level++) {
        const w = Math.max(1, width >> level);
        const h = Math.max(1, height >> level);
        dimensions.push([w, h]);
        if (w === 1 && h === 1) return dimensions;
    }
}

// Material for installing by hand next to the VTF in materials/vgui/logos.
export function buildVMT(baseName) {
    return `"UnlitGeneric"
{
\t"$basetexture"\t"vgui/logos/${baseName}"
\t"$translucent" "1"
\t"$ignorez" "1"
\t"$vertexcolor" "1"
\t"$vertexalpha" "1"
}`;
}
