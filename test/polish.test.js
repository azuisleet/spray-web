import {describe, expect, it} from "vitest";
import {nudgeCrop} from "../src/cropFocus.js";
import {namePasted} from "../src/formats.js";
import {readSetting, writeSetting} from "../src/settings.js";

function memoryStorage() {
    const values = new Map();
    return {getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), values};
}

describe("readSetting and writeSetting", () => {
    it("remembers a value and reads it back", () => {
        const storage = memoryStorage();
        writeSetting("fit", "crop", storage);
        expect(readSetting("fit", ["pad", "crop"], "pad", storage)).toBe("crop");
        writeSetting("swap", 32, storage);
        expect(readSetting("swap", [128, 64, 32, 16], 64, storage)).toBe(32);
    });

    it("falls back when nothing is stored, the value is no longer allowed, or it is garbage", () => {
        const storage = memoryStorage();
        expect(readSetting("fit", ["pad"], "pad", storage)).toBe("pad");
        writeSetting("fit", "zoom", storage);
        expect(readSetting("fit", ["pad", "crop"], "pad", storage)).toBe("pad");
        storage.values.set("spray-converter:fit", "{not json");
        expect(readSetting("fit", ["pad", "crop"], "pad", storage)).toBe("pad");
    });

    it("carries on when storage is missing or refuses", () => {
        const refusing = {getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }};
        expect(readSetting("fit", ["pad"], "pad", refusing)).toBe("pad");
        expect(() => writeSetting("fit", "pad", refusing)).not.toThrow();
        expect(readSetting("fit", ["pad"], "pad", undefined)).toBe("pad");
    });
});

describe("nudgeCrop", () => {
    const wide = {width: 800, height: 400};
    const tall = {width: 400, height: 800};
    const centred = {x: 0.5, y: 0.5};

    it("moves a wide image's crop sideways and a tall one's up and down", () => {
        expect(nudgeCrop(centred, "ArrowRight", wide)).toEqual({x: 0.55, y: 0.5});
        expect(nudgeCrop(centred, "ArrowUp", wide)).toEqual({x: 0.45, y: 0.5});
        expect(nudgeCrop(centred, "ArrowDown", tall)).toEqual({x: 0.5, y: 0.55});
    });

    it("steps further with Shift and Page keys, and jumps to the edges", () => {
        expect(nudgeCrop(centred, "ArrowLeft", wide, true)).toEqual({x: 0.3, y: 0.5});
        expect(nudgeCrop(centred, "PageDown", wide)).toEqual({x: 0.75, y: 0.5});
        expect(nudgeCrop(centred, "Home", wide)).toEqual({x: 0, y: 0.5});
        expect(nudgeCrop(centred, "End", tall)).toEqual({x: 0.5, y: 1});
    });

    it("stops at the edges", () => {
        expect(nudgeCrop({x: 0.98, y: 0.5}, "ArrowRight", wide, true)).toEqual({x: 1, y: 0.5});
        expect(nudgeCrop({x: 0.01, y: 0.5}, "ArrowLeft", wide)).toEqual({x: 0, y: 0.5});
    });

    it("ignores other keys, and square images which have nothing to move", () => {
        expect(nudgeCrop(centred, "a", wide)).toBeNull();
        expect(nudgeCrop(centred, "ArrowRight", {width: 500, height: 500})).toBeNull();
    });
});

describe("namePasted", () => {
    it("names a pasted image by when it was pasted, keeping its type", () => {
        const file = namePasted(new File(["x"], "image.png", {type: "image/png"}), new Date(2026, 9, 2, 14, 22, 33));
        expect(file.name).toBe("pasted-20261002-142233.png");
        expect(file.type).toBe("image/png");
        expect(namePasted(new File(["x"], "image", {type: "image/webp"}), new Date(2026, 0, 5, 1, 2, 3)).name).toBe("pasted-20260105-010203.webp");
    });
});
