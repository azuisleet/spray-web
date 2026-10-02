import {useEffect, useRef} from "react";
import {acceptedTypes} from "../formats.js";
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
            <input ref={inputRef} type="file" className="hidden" accept={acceptedTypes.join(",")}
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
export function SourceThumbnail({info, fit, focus, onFocus}) {
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

    const crop = {
        left: `${(width - side) * focus.x / width * 100}%`,
        top: `${(height - side) * focus.y / height * 100}%`,
        width: `${side / width * 100}%`,
        height: `${side / height * 100}%`,
    };

    return (
        <div className="flex flex-col gap-1">
            <div className={`relative w-full overflow-hidden select-none ${cropping ? "cursor-move touch-none" : ""}`}
                 style={{aspectRatio: `${width} / ${height}`, backgroundImage: "repeating-conic-gradient(#d4d4d4 0 25%, #f5f5f5 0 50%)", backgroundSize: "16px 16px"}}
                 onPointerDown={cropping ? (event) => {
                     event.currentTarget.setPointerCapture(event.pointerId);
                     moveTo(event);
                 } : undefined}
                 onPointerMove={cropping ? (event) => {
                     if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event);
                 } : undefined}>
                <canvas ref={canvasRef} className="h-full w-full"/>
                {cropping && (
                    <div className="pointer-events-none absolute border-2 border-paint shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" style={crop}/>
                )}
            </div>
            <div className="text-sm opacity-70">{describe(info)}</div>
        </div>
    );
}
