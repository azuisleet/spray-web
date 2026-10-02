/**
 * Keyboard control of a crop. The square crop of a non-square image only has room to move
 * along the longer axis, so it behaves as a one-axis slider: arrows step it, Shift steps
 * further, Page Up / Page Down take big steps, Home and End go to either edge.
 *
 * @param focus {x, y} in 0..1
 * @returns the new focus, or null if the key does not move the crop
 */
export function nudgeCrop(focus, key, {width, height}, shiftKey = false) {
    const axis = width > height ? "x" : height > width ? "y" : null;
    if (!axis) return null;

    const step = shiftKey ? 0.2 : 0.05;
    const moves = {
        ArrowLeft: -step, ArrowUp: -step, ArrowRight: step, ArrowDown: step,
        PageUp: -0.25, PageDown: 0.25,
    };
    let value;
    if (key === "Home") value = 0;
    else if (key === "End") value = 1;
    else if (key in moves) value = focus[axis] + moves[key];
    else return null;

    return {...focus, [axis]: Math.min(1, Math.max(0, Math.round(value * 1000) / 1000))};
}
