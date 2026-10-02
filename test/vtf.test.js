import {describe, expect, it} from "vitest";
import {baseFlags, buildHeader, buildVMT, dxt1Size, flagNoMip, headerSize, mipDimensions} from "../src/vtf.js";

describe("buildHeader", () => {
    it("writes a VTF 7.1 header for DXT1", () => {
        const header = buildHeader(1024, 1020, 3, 1, baseFlags | flagNoMip);
        const view = new DataView(header.buffer);
        expect(header.length).toBe(headerSize);
        expect(String.fromCharCode(...header.subarray(0, 3))).toBe("VTF");
        expect([view.getUint32(4, true), view.getUint32(8, true)]).toEqual([7, 1]);
        expect(view.getUint32(0x0C, true)).toBe(headerSize);
        expect([view.getUint16(0x10, true), view.getUint16(0x12, true)]).toEqual([1024, 1020]);
        expect(view.getUint32(0x14, true)).toBe(baseFlags | flagNoMip);
        expect(view.getUint16(0x18, true)).toBe(3);
        expect(view.getUint32(0x34, true)).toBe(13);    // DXT1
        expect(header[0x38]).toBe(1);
    });
});

describe("dxt1Size and mipDimensions", () => {
    it("counts whole 4x4 blocks, at least one", () => {
        expect(dxt1Size(1024, 1020)).toBe(522240);
        expect(dxt1Size(2, 1)).toBe(8);
        expect(dxt1Size(6, 4)).toBe(16);
    });

    it("halves each axis down to 1x1", () => {
        expect(mipDimensions(8, 2)).toEqual([[8, 2], [4, 1], [2, 1], [1, 1]]);
        expect(mipDimensions(512, 1024).length).toBe(11);
    });
});

describe("buildVMT", () => {
    it("points the material at the logo texture", () => {
        expect(buildVMT("my spray")).toContain('"vgui/logos/my spray"');
    });
});
