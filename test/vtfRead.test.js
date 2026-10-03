import {describe, expect, it} from "vitest";
import {decodeDXT1, encodeDXT1} from "../src/dxt1.js";
import {encodeDXT5} from "../src/dxt5.js";
import {baseFlags, buildHeader, flagNoMip, flagPointSample, imageFormatBGRA8888, imageFormatDXT5, mipDimensions} from "../src/vtf.js";
import {describeFlags, readVTF} from "../src/vtfRead.js";
import {codecs} from "../src/codecs.js";
import {formatBGR888, textureFormats} from "../src/textureFormats.js";

function image(width, height, pixel) {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4);
    return rgba;
}

const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
};

const pattern = (frame) => image(16, 16, (x, y) => [x * 16, y * 16, frame * 80, 255]);

describe("readVTF", () => {
    it("reads back a BGR888 spray from the converter's codec, opaque", () => {
        const rgba = image(16, 16, (x, y) => [x * 16, y * 16, 99, 255]);
        const data = codecs[formatBGR888].encode(16, 16, rgba);
        expect(data.length).toBe(textureFormats[formatBGR888].size(16, 16));
        const vtf = readVTF(concat(buildHeader(16, 16, 1, 1, flagNoMip, textureFormats[formatBGR888].vtf), data));
        expect(vtf.formatName).toBe("BGR888");
        expect(vtf.levels[0][0]).toEqual(rgba);
        expect(codecs[formatBGR888].decode(16, 16, data)).toEqual(rgba);
        expect(vtf.checks.some(c => c.severity !== "info")).toBe(false);
    });

    it("reads back an animated DXT1 spray exactly as encoded", () => {
        const frames = [0, 1, 2].map(f => encodeDXT1(16, 16, pattern(f)));
        const file = concat(buildHeader(16, 16, 3, 1, baseFlags | flagNoMip), ...frames);
        const vtf = readVTF(file);
        expect([vtf.version, vtf.width, vtf.height, vtf.frames, vtf.mipCount, vtf.formatName]).toEqual(["7.1", 16, 16, 3, 1, "DXT1"]);
        frames.forEach((blocks, f) => expect(vtf.levels[0][f]).toEqual(decodeDXT1(16, 16, blocks)));
        expect(vtf.checks.some(c => c.severity === "warning" || c.severity === "error")).toBe(false);
    });

    it("finds each mip level with the smallest stored first", () => {
        const levels = mipDimensions(8, 8).map(([w, h], level) => {
            const rgba = image(Math.max(4, w), Math.max(4, h), () => [level * 60, 0, 0, 255]);
            return encodeDXT1(Math.max(4, w), Math.max(4, h), rgba);
        });
        const file = concat(buildHeader(8, 8, 1, levels.length, baseFlags), ...levels.slice().reverse());
        const vtf = readVTF(file);
        expect(vtf.mipCount).toBe(4);
        vtf.levels.forEach((frames, level) => expect(frames[0][0]).toBeCloseTo(level * 60, -1));
    });

    it("reads DXT5 and BGRA8888, and notices point sampling", () => {
        const rgba = image(8, 8, (x) => [200, 100, 50, x * 32]);
        const dxt5 = readVTF(concat(buildHeader(8, 8, 1, 1, baseFlags, imageFormatDXT5), encodeDXT5(8, 8, rgba)));
        expect(dxt5.formatName).toBe("DXT5");
        expect(Math.abs(dxt5.levels[0][0][4 * 3 + 3] - 96)).toBeLessThanOrEqual(8);

        const bgra = new Uint8Array(rgba.length);
        for (let i = 0; i < rgba.length; i += 4) bgra.set([rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]], i);
        const exact = readVTF(concat(buildHeader(8, 8, 1, 1, baseFlags | flagPointSample, imageFormatBGRA8888), bgra));
        expect(exact.levels[0][0]).toEqual(rgba);
        expect(exact.pointSample).toBe(true);
    });

    it("finds the image through the resource table of a 7.3 file", () => {
        const blocks = encodeDXT1(8, 8, image(8, 8, () => [10, 200, 10, 255]));
        const header = new Uint8Array(0x50 + 8);
        header.set(buildHeader(8, 8, 1, 1, baseFlags | flagNoMip));
        const view = new DataView(header.buffer);
        view.setUint32(8, 3, true);                 // version 7.3
        view.setUint32(12, header.length, true);    // header size
        view.setUint16(0x3F, 1, true);              // depth
        view.setUint32(0x44, 1, true);              // one resource
        header[0x50] = 0x30;                        // image data...
        view.setUint32(0x54, header.length, true);  // ...starting right after the header
        const vtf = readVTF(concat(header, blocks));
        expect(vtf.version).toBe("7.3");
        expect(vtf.levels[0][0]).toEqual(decodeDXT1(8, 8, blocks));
    });

    it("warns about files over 512 KB, uneven mip chains and untested formats", () => {
        const big = readVTF(concat(buildHeader(1024, 1024, 1, 1, baseFlags | flagNoMip), new Uint8Array(1024 * 1024 / 2)));
        expect(big.checks.some(c => c.severity === "warning" && c.text.includes("512 KB"))).toBe(true);

        const uneven = mipDimensions(12, 12).map(([w, h]) => new Uint8Array(Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * 8));
        const npot = readVTF(concat(buildHeader(12, 12, 1, uneven.length, baseFlags), ...uneven));
        expect(npot.checks.some(c => c.text.includes("not a power of two"))).toBe(true);

        const i8 = readVTF(concat(buildHeader(4, 4, 1, 1, baseFlags | flagNoMip, 5), new Uint8Array(16).fill(128)));
        expect(i8.formatName).toBe("I8");
        expect([...i8.levels[0][0].subarray(0, 4)]).toEqual([128, 128, 128, 255]);
        expect(i8.checks.some(c => c.text.includes("not been tested"))).toBe(true);
    });

    it("refuses what it cannot show, saying why", () => {
        expect(readVTF(new TextEncoder().encode("not a texture at all, just some words here to fill sixty-four bytes")).checks[0].text).toMatch(/not a VTF/);
        const header = buildHeader(16, 16, 1, 1, baseFlags | flagNoMip);
        expect(readVTF(concat(header, new Uint8Array(10))).checks.at(-1).text).toMatch(/cut off/);
        expect(readVTF(concat(buildHeader(4, 4, 1, 1, 0x4000), new Uint8Array(64))).checks.at(-1).text).toMatch(/cube map/);
    });
});

describe("describeFlags", () => {
    it("names the flags a spray carries", () => {
        expect(describeFlags(baseFlags | flagNoMip)).toEqual(["clamp S", "clamp T", "no mips", "no LOD", "1-bit alpha"]);
    });
});
