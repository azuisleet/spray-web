import {useEffect, useRef} from "react";
import {nudgeCrop} from "../cropFocus.js";
import {acceptAttribute} from "../formats.js";
import {fitCrop, fitPad, fitStretch} from "../plan.js";

const fitOptions = [
    {value: fitPad, label: "Pad", hint: "Whole image, transparent bands to fill the square"},
    {value: fitCrop, label: "Crop", hint: "Largest square; drag on the image to choose which part"},
    {value: fitStretch, label: "Stretch", hint: "Whole image, distorted to fill the square"},
];

export function DropZone({label, hint, file, onSelect, compact = false}) {
    const inputRef = useRef(null);
    return (
        <div role="button" tabIndex={0}
             className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-sm border-2 border-dashed border-zinc-400 px-3 text-center hover:border-paint ${compact ? "py-3" : "py-8"}`}
             onClick={() => inputRef.current.click()}
             onKeyDown={(event) => {
                 if (event.key === "Enter" || event.key === " ") inputRef.current.click();
             }}
             onDragOver={(event) => event.preventDefault()}
             onDrop={(event) => {
                 event.preventDefault();
                 event.stopPropagation();
                 const dropped = event.dataTransfer.files?.[0];
                 if (dropped) onSelect(dropped);
             }}>
            <div className="font-semibold">{label}</div>
            <div className="max-w-full truncate text-sm opacity-70">{file ? file.name : hint}</div>
            <input ref={inputRef} type="file" className="hidden" accept={acceptAttribute}
                   onClick={(event) => event.stopPropagation()}
                   onChange={(event) => {
                       const selected = event.target.files?.[0];
                       if (selected) onSelect(selected);
                       event.target.value = null;
                   }}/>
        </div>
    );
}

export function FitControl({fit, onChange}) {
    return (
        <div className="flex rounded-sm border border-zinc-400 text-sm" role="radiogroup" aria-label="Fit">
            {fitOptions.map(option => (
                <button key={option.value} type="button" role="radio" aria-checked={fit === option.value} title={option.hint}
                        onClick={() => onChange(option.value)}
                        className={`grow cursor-pointer px-3 py-1 first:rounded-l-xs last:rounded-r-xs ${fit === option.value ? "bg-paint text-ink" : "hover:bg-zinc-200 dark:hover:bg-zinc-700"}`}>
                    {option.label}
                </button>
            ))}
        </div>
    );
}

function describe(info) {
    if (info.video) return `${info.width}×${info.height}, ${info.video.duration.toFixed(1)} s video`;
    const parts = [`${info.width}×${info.height}`];
    if (info.frameCount > 1) {
        const seconds = info.durations.reduce((sum, d) => sum + d, 0) / 1000;
        parts.push(`${info.frameCount} frames`, `${seconds.toFixed(1)} s`);
    }
    return parts.join(", ");
}

/**
 * The source's first frame. In crop mode a square marks what is kept, and dragging moves
 * it; focus is 0..1 along whichever axis has room to move.
 */
export function SourceThumbnail({info, fit, focus, onFocus, pixelated = false}) {
    const canvasRef = useRef(null);
    const {thumbnail, width, height} = info;
    const side = Math.min(width, height);
    const cropping = fit === fitCrop && width !== height;

    useEffect(() => {
        const canvas = canvasRef.current;
        canvas.width = thumbnail.width;
        canvas.height = thumbnail.height;
        canvas.getContext("2d").drawImage(thumbnail, 0, 0);
    }, [thumbnail]);

    const moveTo = (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width * width;
        const y = (event.clientY - box.top) / box.height * height;
        const clamp = (v) => Math.min(1, Math.max(0, v));
        onFocus({
            x: width > side ? clamp((x - side / 2) / (width - side)) : 0.5,
            y: height > side ? clamp((y - side / 2) / (height - side)) : 0.5,
        });
    };

    const longAxis = width > height ? "x" : "y";
    const crop = {
        left: `${(width - side) * focus.x / width * 100}%`,
        top: `${(height - side) * focus.y / height * 100}%`,
        width: `${side / width * 100}%`,
        height: `${side / height * 100}%`,
    };

    return (
        <div className="flex flex-col gap-1">
            <div className={`relative w-full overflow-hidden select-none ${cropping ? "cursor-move touch-none" : ""}`}
                 {...(cropping && {
                     tabIndex: 0,
                     role: "slider",
                     "aria-label": "Crop position",
                     "aria-orientation": longAxis === "x" ? "horizontal" : "vertical",
                     "aria-valuemin": 0,
                     "aria-valuemax": 100,
                     "aria-valuenow": Math.round(focus[longAxis] * 100),
                     title: "Drag, or use the arrow keys, to choose what the crop keeps",
                     onKeyDown: (event) => {
                         const next = nudgeCrop(focus, event.key, {width, height}, event.shiftKey);
                         if (!next) return;
                         event.preventDefault();
                         onFocus(next);
                     },
                 })}
                 style={{aspectRatio: `${width} / ${height}`, backgroundImage: "repeating-conic-gradient(#d4d4d4 0 25%, #f5f5f5 0 50%)", backgroundSize: "16px 16px"}}
                 onPointerDown={cropping ? (event) => {
                     event.currentTarget.setPointerCapture(event.pointerId);
                     moveTo(event);
                 } : undefined}
                 onPointerMove={cropping ? (event) => {
                     if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event);
                 } : undefined}>
                <canvas ref={canvasRef} className="h-full w-full" style={{imageRendering: pixelated ? "pixelated" : "auto"}}/>
                {cropping && (
                    <div className="pointer-events-none absolute border-2 border-paint shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" style={crop}/>
                )}
            </div>
            <div className="text-sm opacity-70">{describe(info)}</div>
        </div>
    );
}

/**
 * Start and end of the span of a video to use, in seconds. They stay at least a fifth of a
 * second apart: one frame at the engine's rate.
 */
export function TrimControl({duration, trim, onTrim}) {
    const gap = 0.2;
    const length = trim.end - trim.start;
    const frames = Math.max(1, Math.round(length * 5));
    const slider = (label, value, onChange) => (
        <label className="flex items-center gap-2 text-sm">
            <span className="w-10 text-steel dark:text-zinc-400">{label}</span>
            <input type="range" className="grow" min={0} max={duration} step={0.1} value={value}
                   onChange={(event) => onChange(Number(event.target.value))}/>
            <span className="w-12 text-right tabular-nums">{value.toFixed(1)} s</span>
        </label>
    );
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm text-steel dark:text-zinc-400">Part of the video to use</span>
            {slider("Start", trim.start, (start) => onTrim({start: Math.min(start, trim.end - gap), end: trim.end}))}
            {slider("End", trim.end, (end) => onTrim({start: trim.start, end: Math.max(end, trim.start + gap)}))}
            <span className="text-sm text-steel dark:text-zinc-400">
                {length.toFixed(1)} s of {duration.toFixed(1)} s: {frames} frame{frames === 1 ? "" : "s"} at 5 a second in game
            </span>
        </div>
    );
}
