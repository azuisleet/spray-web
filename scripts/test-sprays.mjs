/**
 * Writes diagnostic sprays for checking in game how the engine treats spray dimensions.
 *
 *   npm run test-sprays            -> test-sprays/*.vtf, *.vmt, and *.png previews
 *
 * Animated ones show the frame number and a row of cells with the current frame's lit,
 * so playback order and any dropped frame are visible; their preview has the frames
 * side by side.
 *
 * Every pattern is drawn in pure colours on black, sharp-edged, so DXT1 keeps it
 * close to exact and any blur or misplacement seen in game is the engine's doing.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import {decodeDXT1, encodeDXT1} from "../src/dxt1.js";
import {baseFlags, buildHeader, buildVMT, flagEightBitAlpha, flagNoMip, flagOneBitAlpha, headerSize, maximumSize} from "../src/vtf.js";

const uploadLimit = 512 * 1024;
const outDir = path.resolve(import.meta.dirname, "..", "test-sprays");

const sprays = [
    {width: 1024, height: 1020, note: "largest 1024-wide spray that fits"},
    {width: 1020, height: 1024, note: "same budget, width not a power of two"},
    {width: 1008, height: 1040, note: "fills the converter's whole budget, what large stills now get"},
    {width: 1024, height: 256, note: "4:1 aspect test: TF2 stretches it to fill a square decal"},
    {width: 512, height: 512, note: "control"},
    {width: 720, height: 724, frames: 2, note: "animated, neither side a power of two"},
    {width: 360, height: 360, frames: 8, note: "animated, many small frames"},
    {width: 256, height: 256, frames: 8, note: "animated control, powers of two"},
    // Same transparent-background pattern, differing only in the alpha flag; the caption
    // shows the flag value. All three looked identical in TF2; the converter writes 0x1000.
    {width: 512, height: 512, alphaFlag: flagOneBitAlpha, note: "ONEBITALPHA, transparent background"},
    {width: 512, height: 512, alphaFlag: flagEightBitAlpha, note: "EIGHTBITALPHA, transparent background"},
    {width: 512, height: 512, alphaFlag: 0, note: "no alpha flag, transparent background"},
    {width: 1024, height: 1024, note: "over the limit, expected to be refused"},
];

const black = [0, 0, 0];
const white = [255, 255, 255];
const grey = [66, 65, 66];
const yellow = [255, 255, 0];
const red = [255, 0, 0];
const green = [0, 255, 0];
const blue = [0, 0, 255];
const magenta = [255, 0, 255];

// 5x7 glyphs, one string per row.
const glyphs = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    "x": ["00000", "00000", "10001", "01010", "00100", "01010", "10001"],
    "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
};

function drawPattern(width, height, frame, frames, {transparent = false, caption = null} = {}) {
    const pixels = new Uint8Array(width * height * 4);

    const set = (x, y, [r, g, b]) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const p = (y * width + x) * 4;
        pixels[p] = r; pixels[p + 1] = g; pixels[p + 2] = b; pixels[p + 3] = 255;
    };
    const rect = (x0, y0, w, h, colour) => {
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, colour);
    };
    const text = (string, x0, y0, scale, colour) => {
        for (const [n, ch] of [...string].entries()) {
            glyphs[ch].forEach((row, gy) => [...row].forEach((bit, gx) => {
                if (bit === "1") rect(x0 + (n * 6 + gx) * scale, y0 + gy * scale, scale, scale, colour);
            }));
        }
    };
    const textWidth = (string, scale) => (string.length * 6 - 1) * scale;
    const ring = (cx, cy, radius, thickness, colour) => {
        for (let y = Math.floor(cy - radius - 1); y <= cy + radius + 1; y++) {
            for (let x = Math.floor(cx - radius - 1); x <= cx + radius + 1; x++) {
                const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
                if (d <= radius && d > radius - thickness) set(x, y, colour);
            }
        }
    };

    // A transparent background leaves the pixels at zero: alpha 0, where the wall shows.
    if (!transparent) rect(0, 0, width, height, black);

    // Grid every 64 px, with a white cross through the exact centre.
    for (let x = 64; x < width; x += 64) rect(x, 0, 1, height, grey);
    for (let y = 64; y < height; y += 64) rect(0, y, width, 1, grey);
    rect(width / 2 - 1, 0, 2, height, white);
    rect(0, height / 2 - 1, width, 2, white);

    // Round only if texels end up square on the wall.
    const outer = Math.min(width, height) / 2 - 48;
    ring(width / 2, height / 2, outer, 3, white);
    ring(width / 2, height / 2, outer / 2, 3, white);

    // Rulers on all four edges: ticks every 4 px, longer at 16 and 64, numbered every 128.
    const tick = (i) => (i % 64 === 0 ? 15 : i % 16 === 0 ? 7 : 3);
    for (let x = 0; x < width; x += 4) {
        rect(x, 2, 1, tick(x), white);
        rect(x, height - 2 - tick(x), 1, tick(x), white);
    }
    for (let y = 0; y < height; y += 4) {
        rect(2, y, tick(y), 1, white);
        rect(width - 2 - tick(y), y, tick(y), 1, white);
    }
    for (let x = 128; x < width; x += 128) {
        const label = String(x);
        text(label, x - textWidth(label, 2) / 2, 20, 2, white);
        text(label, x - textWidth(label, 2) / 2, height - 34, 2, white);
    }
    for (let y = 128; y < height; y += 128) {
        const label = String(y);
        text(label, 20, y - 7, 2, white);
        text(label, width - 20 - textWidth(label, 2), y - 7, 2, white);
    }

    // The very last row and column, so any clipping shows as a missing yellow edge.
    rect(0, 0, width, 1, yellow);
    rect(0, height - 1, width, 1, yellow);
    rect(0, 0, 1, height, yellow);
    rect(width - 1, 0, 1, height, yellow);

    // Orientation: a flip or rotation moves these.
    const corner = 32, inset = 40;
    rect(inset, inset, corner, corner, red);
    rect(width - inset - corner, inset, corner, corner, green);
    rect(inset, height - inset - corner, corner, corner, blue);
    rect(width - inset - corner, height - inset - corner, corner, corner, magenta);

    // Resampling detectors. A resize along one axis greys out the stripes that vary along
    // that axis and leaves the other set crisp; the checkerboard catches either.
    const patch = Math.min(96, Math.floor(height / 6 / 4) * 4);
    const patchY = Math.round(height * 0.62 / 4) * 4;
    const patchStep = patch + 32;
    const patchX = Math.round((width / 2 - patchStep * 1.5 + 16) / 4) * 4;
    const patterns = [
        (x, y) => (x + y) % 2 === 0,    // checkerboard
        (x) => x % 2 === 0,             // vertical stripes: vary along the width
        (x, y) => y % 2 === 0,          // horizontal stripes: vary along the height
    ];
    patterns.forEach((on, n) => {
        const x0 = patchX + n * patchStep;
        rect(x0 - 4, patchY - 4, patch + 8, patch + 8, black);
        for (let y = 0; y < patch; y++) for (let x = 0; x < patch; x++) set(x0 + x, patchY + y, on(x, y) ? white : black);
    });

    const label = `${width}x${height}`;
    const scale = Math.max(2, Math.min(Math.floor(width * 0.5 / (label.length * 6)), Math.floor(height * 0.12 / 7)));
    const labelX = Math.round((width - textWidth(label, scale)) / 2);
    const labelY = Math.round(height * 0.3 - 3.5 * scale);
    rect(labelX - scale, labelY - scale, textWidth(label, scale) + 2 * scale, 9 * scale, black);
    text(label, labelX, labelY, scale, white);

    if (caption) {
        const captionX = Math.round((width - textWidth(caption, scale)) / 2);
        const captionY = labelY + 9 * scale;
        rect(captionX - scale, captionY - scale, textWidth(caption, scale) + 2 * scale, 9 * scale, black);
        text(caption, captionX, captionY, scale, white);
    }

    if (frames > 1) {
        const counter = `${frame + 1}/${frames}`;
        const counterX = Math.round((width - textWidth(counter, scale)) / 2);
        const counterY = labelY + 9 * scale;
        rect(counterX - scale, counterY - scale, textWidth(counter, scale) + 2 * scale, 9 * scale, black);
        text(counter, counterX, counterY, scale, white);

        const cell = Math.floor(textWidth(label, scale) / frames);
        const trackY = counterY + 9 * scale;
        rect(labelX - scale, trackY - scale, cell * frames + scale, 4 * scale, black);
        for (let n = 0; n < frames; n++) {
            rect(labelX + n * cell, trackY, cell - scale, 2 * scale, n === frame ? white : grey);
        }
    }

    return pixels;
}

function encodePNG(width, height, rgba) {
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(body));
        return Buffer.concat([length, body, crc]);
    };

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 6;    // RGBA

    const rows = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        rows[y * (width * 4 + 1)] = 0;  // no filter
        rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

fs.mkdirSync(outDir, {recursive: true});

for (const {width, height, frames = 1, alphaFlag, note} of sprays) {
    const alphaTest = alphaFlag !== undefined;
    let name = frames > 1 ? `spraytest_${width}x${height}_${frames}f` : `spraytest_${width}x${height}`;
    if (alphaTest) name += `_alpha${alphaFlag.toString(16)}`;
    const options = alphaTest ? {transparent: true, caption: `0x${alphaFlag.toString(16)}`} : {};
    const flags = alphaTest
        ? (baseFlags & ~(flagOneBitAlpha | flagEightBitAlpha)) | alphaFlag | flagNoMip
        : baseFlags | flagNoMip;

    // Without mips a VTF is simply every frame's top level, one after another.
    const frameBlocks = Array.from({length: frames}, (_, frame) => encodeDXT1(width, height, drawPattern(width, height, frame, frames, options)));
    const vtf = Buffer.concat([buildHeader(width, height, frames, 1, flags), ...frameBlocks]);

    fs.writeFileSync(path.join(outDir, `${name}.vtf`), vtf);
    fs.writeFileSync(path.join(outDir, `${name}.vmt`), buildVMT(name));

    // Decoded from the DXT1 data, so this is what the game should show.
    const sheet = new Uint8Array(width * frames * height * 4);
    frameBlocks.forEach((blocks, frame) => {
        const decoded = decodeDXT1(width, height, blocks);
        for (let y = 0; y < height; y++) {
            sheet.set(decoded.subarray(y * width * 4, (y + 1) * width * 4), (y * width * frames + frame * width) * 4);
        }
    });
    fs.writeFileSync(path.join(outDir, `${name}.png`), encodePNG(width * frames, height, sheet));

    const payload = vtf.length - headerSize;
    const fits = vtf.length <= uploadLimit ? "under 512 KiB" : "OVER 512 KiB";
    const budget = payload <= maximumSize ? "" : ", over the converter's budget";
    console.log(`${name}.vtf  ${vtf.length.toLocaleString().padStart(7)} bytes  ${fits}${budget}  (${note})`);
}

console.log(`\nWritten to ${outDir}`);
