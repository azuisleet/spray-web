/**
 * Minimal zip writer: files are stored uncompressed. DXT1 data is already compressed and
 * barely shrinks under deflate, so storing keeps this small and fast without a library.
 *
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
}

export function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS date and time, which zip stores for every entry.
function dosDateTime(date) {
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

const utf8Flag = 0x0800;

/**
 * @param entries [{name, data: Uint8Array}]; names may contain "/" for folders
 * @returns Uint8Array of the whole archive
 */
export function createZip(entries, date = new Date()) {
    const encoder = new TextEncoder();
    const {time, date: day} = dosDateTime(date);
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const {name, data} of entries) {
        const nameBytes = encoder.encode(name);
        const crc = crc32(data);

        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034B50, true);   // local file header
        lv.setUint16(4, 20, true);           // version needed: 2.0
        lv.setUint16(6, utf8Flag, true);
        lv.setUint16(8, 0, true);            // stored
        lv.setUint16(10, time, true);
        lv.setUint16(12, day, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true); // compressed size
        lv.setUint32(22, data.length, true); // uncompressed size
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);           // extra field length
        local.set(nameBytes, 30);

        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014B50, true);   // central directory header
        cv.setUint16(4, 20, true);           // version made by
        cv.setUint16(6, 20, true);           // version needed
        cv.setUint16(8, utf8Flag, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, day, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        // 30 extra length, 32 comment length, 34 disk, 36 internal attributes, 38 external: all 0
        cv.setUint32(42, offset, true);      // where the local header starts
        central.set(nameBytes, 46);

        locals.push(local, data);
        centrals.push(central);
        offset += local.length + data.length;
    }

    const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054B50, true);       // end of central directory
    ev.setUint16(8, entries.length, true);   // entries on this disk
    ev.setUint16(10, entries.length, true);  // entries in total
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);          // where the central directory starts

    const parts = [...locals, ...centrals, end];
    const archive = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const part of parts) {
        archive.set(part, at);
        at += part.length;
    }
    return archive;
}

/**
 * Makes names unique within a set by numbering repeats: "a.vtf", "a-2.vtf", ...
 * Compares without case, since Windows would treat them as the same file.
 */
export function uniqueNames(names) {
    const seen = new Set();
    return names.map(name => {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        let candidate = name;
        for (let n = 2; seen.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${extension}`;
        seen.add(candidate.toLowerCase());
        return candidate;
    });
}
