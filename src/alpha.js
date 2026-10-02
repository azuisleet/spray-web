/**
 * Whether an image has soft edges worth keeping: enough pixels that are visibly partly
 * transparent.
 *
 * "Visibly" leaves out alpha within a few steps of clear or solid. Those differences cannot
 * be seen, and some images carry them for other reasons: image generators hide their
 * settings in the lowest bit of the alpha channel (alpha 254 down one edge), and editors
 * leave the odd 1 or 254 behind. Counting those would spend twice the bytes per pixel on
 * an image that looks fully opaque.
 */

// Alpha this close to 0 or 255 counts as clear or solid: about 3%, too little to see.
const invisibleAlpha = 8;

// Share of pixels that must be visibly partial: enough to rule out a few stray pixels,
// few enough that an anti-aliased outline still counts.
const softAlphaShare = 0.002;

export function hasSoftAlpha(pixels) {
    let partial = 0;
    for (let i = 3; i < pixels.length; i += 4) {
        const a = pixels[i];
        if (a >= invisibleAlpha && a <= 255 - invisibleAlpha) partial++;
    }
    return partial > (pixels.length / 4) * softAlphaShare;
}
