import {encodeDXT1} from "./dxt1.js";
import {resampleRows} from "./resample.js";

self.onmessage = ({data: {id, source, level, rowStart, rows}}) => {
    try {
        const pixels = resampleRows(source, level.width, level.height, level.rect, rowStart, rows);
        const blocks = encodeDXT1(level.width, rows, pixels);
        self.postMessage({id, blocks}, [blocks.buffer]);
    } catch (err) {
        self.postMessage({id, error: err.message});
    }
};
