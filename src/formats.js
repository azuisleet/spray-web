// Browsers do not know VTF; this is its registered type, given to files by their name.
export const vtfType = "image/vnd.valve.source.texture";

export const acceptedTypes = [
    "image/gif", "image/png", "image/apng", "image/jpeg", "image/webp", "image/avif",
    "video/mp4", "video/webm", "video/quicktime", vtfType,
];
export const acceptedNames = "GIF, PNG, JPEG, WebP, AVIF, MP4, WebM or VTF";

// For file pickers, which also need the extension since no browser knows VTF's type.
export const acceptAttribute = [...acceptedTypes, ".vtf"].join(",");

/** The file with a type a browser leaves out: a VTF arrives typeless. */
export function withKnownType(file) {
    if (!file.type && /\.vtf$/i.test(file.name)) return new File([file], file.name, {type: vtfType});
    return file;
}

export const isVtf = (file) => file.type === vtfType;

// Clipboard images arrive as "image.png" whatever they are; a timestamp keeps each
// pasted spray's download name distinct.
export function namePasted(file, now = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const extension = file.type.split("/")[1]?.split("+")[0] || "png";
    return new File([file], `pasted-${stamp}.${extension}`, {type: file.type});
}
