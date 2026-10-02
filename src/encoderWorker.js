import {codecs} from "./codecs.js";
import {formatDXT1} from "./textureFormats.js";
import {resampleRows} from "./resample.js";

self.onmessage = ({data: {id, source, level, rowStart, rows}}) => {
    try {
        const pixels = resampleRows(source, level.width, level.height, level.placement, rowStart, rows);
        const blocks = codecs[level.format ?? formatDXT1].encode(level.width, rows, pixels);
        self.postMessage({id, blocks}, [blocks.buffer]);
    } catch (err) {
        self.postMessage({id, error: err.message});
    }
};
