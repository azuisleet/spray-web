import {formatBGR888, formatBGRA8888, formatDXT5, textureFormats} from "../textureFormats.js";
import {buildVMT} from "../vtf.js";
import {downloadBlob} from "../useConversion.js";

const uploadLimit = 512 * 1024;

function formatDescription(format) {
    const {label} = textureFormats[format];
    if (format === formatDXT5) return `${label}, soft edges`;
    if (format === formatBGRA8888) return `${label}, exact color`;
    if (format === formatBGR888) return `${label}, exact color, opaque`;
    return label;
}

function speedText(speed) {
    if (Math.abs(speed - 1) < 0.05) return "real speed";
    return speed > 1 ? `${speed.toFixed(1)}× fast` : `${(1 / speed).toFixed(1)}× slow`;
}

// Choices that come out the same share a card, so a source that fits whole shows one.
function groupCandidates(candidates) {
    const groups = new Map();
    for (const candidate of candidates) {
        const {target} = candidate;
        const signature = target ? `${target.targetWidth}x${target.targetHeight}x${target.frames}` : candidate.key;
        if (!groups.has(signature)) groups.set(signature, {...candidate, keys: [], labels: []});
        groups.get(signature).keys.push(candidate.key);
        groups.get(signature).labels.push(candidate.label);
    }
    return [...groups.values()];
}

/** The choices for this source side by side, with what each would produce. */
export function ChoicePicker({candidates, selected, onSelect}) {
    if (candidates.length <= 1) return null;
    return (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Size and frames">
            {groupCandidates(candidates).map(candidate => {
                const {target} = candidate;
                const active = candidate.keys.includes(selected);
                return (
                    <button key={candidate.key} type="button" role="radio" aria-checked={active}
                            onClick={() => {
                                if (!active) onSelect(candidate.keys.includes("balanced") ? "balanced" : candidate.keys[0]);
                            }}
                            className={`cursor-pointer rounded-sm border px-3 py-2 text-left ${active ? "border-paint bg-paint/10" : "border-zinc-300 hover:border-zinc-500 dark:border-zinc-700"}`}>
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="font-display text-lg leading-tight font-semibold">{candidate.labels.join(" / ")}</span>
                            <span className="text-sm whitespace-nowrap tabular-nums opacity-70">{speedText(candidate.speed)}</span>
                        </div>
                        <div className="text-sm tabular-nums opacity-80">
                            {target ? `${target.targetWidth}×${target.targetHeight}, ${target.frames} frames, ${candidate.playSeconds.toFixed(1)} s` : "does not fit"}
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

/** What was made, how much of the size limit it uses, and the downloads. */
export function OutputPanel({result, baseName}) {
    const used = result.bytes / uploadLimit;
    const facts = [
        ["Texture", `${result.width}×${result.height}`],
        ["Format", formatDescription(result.format)],
        result.pointSample && ["Pixels", result.pixelScale > 1 ? `point sampled, 1 texel per ${result.pixelScale}×${result.pixelScale} pixels` : "point sampled, one texel each"],
        // A video's own count is only the grid it was sampled on, so it is left out.
        result.sourceFrames > 1 && ["Frames", result.video ? `${result.frames}` : `${result.frames} from ${result.sourceFrames}`],
        result.sourceFrames > 1 && ["Plays in", `${result.playSeconds.toFixed(1)} s (original ${result.sourceSeconds.toFixed(1)} s)`],
        result.padding > 0.005 && ["Padding", `${Math.round(result.padding * 100)}%`],
        result.swapLevel !== null && ["Distant image", `mip ${result.swapLevel} (${result.swapDimension} px) down`],
    ].filter(Boolean);

    return (
        <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                {facts.map(([term, value]) => (
                    <div key={term} className="contents">
                        <dt className="opacity-70">{term}</dt>
                        <dd className="tabular-nums">{value}</dd>
                    </div>
                ))}
            </dl>

            <div>
                <div className="mb-1 flex justify-between text-sm">
                    <span className="opacity-70">Size</span>
                    <span className="tabular-nums">{result.bytes.toLocaleString()} / {uploadLimit.toLocaleString()} bytes</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" role="meter"
                     aria-valuemin={0} aria-valuemax={uploadLimit} aria-valuenow={result.bytes} aria-label="Size against the 512 KB limit">
                    <div className="h-full bg-paint" style={{width: `${Math.min(100, used * 100)}%`}}/>
                </div>
            </div>

            <button type="button" onClick={() => downloadBlob(result.blob, `${baseName}.vtf`)}
                    className="cursor-pointer rounded-xs bg-paint px-4 py-2 font-semibold text-ink hover:bg-paint-strong">
                Download {baseName}.vtf
            </button>
            <button type="button" onClick={() => downloadBlob(new Blob([buildVMT(baseName)], {type: "text/plain"}), `${baseName}.vmt`)}
                    className="cursor-pointer self-start text-sm underline opacity-80"
                    title="TF2's spray import writes its own; this is only for copying files in by hand">
                {baseName}.vmt, for installing by hand
            </button>
        </div>
    );
}
