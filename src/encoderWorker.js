import {encodeDXT1} from "./dxt1.js";

self.onmessage = ({data: {id, width, height, pixels}}) => {
    try {
        const blocks = encodeDXT1(width, height, pixels);
        self.postMessage({id, blocks}, [blocks.buffer]);
    } catch (err) {
        self.postMessage({id, error: err.message});
    }
};
