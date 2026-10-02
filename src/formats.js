export const acceptedTypes = [
    "image/gif", "image/png", "image/apng", "image/jpeg", "image/webp", "image/avif",
    "video/mp4", "video/webm", "video/quicktime",
];
export const acceptedNames = "GIF, PNG, JPEG, WebP, AVIF, MP4 or WebM";

// Clipboard images arrive as "image.png" whatever they are; a timestamp keeps each
// pasted spray's download name distinct.
export function namePasted(file, now = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const extension = file.type.split("/")[1]?.split("+")[0] || "png";
    return new File([file], `pasted-${stamp}.${extension}`, {type: file.type});
}
