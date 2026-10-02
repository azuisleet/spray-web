import {describe, expect, it} from "vitest";
import {crc32, createZip, uniqueNames} from "../src/zip.js";

const text = (s) => new TextEncoder().encode(s);

describe("crc32", () => {
    it("matches the standard check values", () => {
        expect(crc32(text("123456789"))).toBe(0xCBF43926);
        expect(crc32(text(""))).toBe(0);
    });
});

describe("createZip", () => {
    it("stores each file after a local header and indexes them at the end", () => {
        const archive = createZip([{name: "a.vtf", data: text("hello")}, {name: "dir/b.vmt", data: text("world!")}], new Date(2026, 9, 1, 12, 30, 10));
        const view = new DataView(archive.buffer);

        expect(view.getUint32(0, true)).toBe(0x04034B50);
        expect(new TextDecoder().decode(archive.subarray(30, 35))).toBe("a.vtf");
        expect(new TextDecoder().decode(archive.subarray(35, 40))).toBe("hello");
        expect(view.getUint32(14, true)).toBe(crc32(text("hello")));

        const end = archive.length - 22;
        expect(view.getUint32(end, true)).toBe(0x06054B50);
        expect(view.getUint16(end + 10, true)).toBe(2);
        const centralStart = view.getUint32(end + 16, true);
        expect(view.getUint32(centralStart, true)).toBe(0x02014B50);
        // The second entry's local header offset points at its local header.
        const secondCentral = centralStart + 46 + "a.vtf".length;
        expect(view.getUint32(view.getUint32(secondCentral + 42, true), true)).toBe(0x04034B50);
    });

    it("writes an empty archive as just the end record", () => {
        expect(createZip([]).length).toBe(22);
    });
});

describe("uniqueNames", () => {
    it("numbers repeats, ignoring case", () => {
        expect(uniqueNames(["a.vtf", "A.vtf", "b.vtf", "a.vtf", "a-2.vtf"])).toEqual(["a.vtf", "A-2.vtf", "b.vtf", "a-3.vtf", "a-2-2.vtf"]);
    });
});
