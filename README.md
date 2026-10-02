# Spray Converter

Turn images and GIFs into Team Fortress 2 sprays, right in your browser.

**Use it at [azuisleet.github.io](https://azuisleet.github.io).** Nothing is uploaded: decoding,
resizing and compression all happen on your machine.

## What it does

- Takes GIF, PNG, JPEG, WebP, AVIF and animated PNG/WebP files.
- Fits the spray inside TF2's 512 KB limit, choosing the texture size and frame count
  together. For animations you pick whether to favour resolution, smooth motion, or a balance.
- Keeps a GIF's timing when frames have to be dropped, by choosing frames by time rather
  than by index.
- **Mip trick:** a second image that takes over once the spray is far enough away, at a
  distance you choose.
- Writes a `.vtf` (DXT1 with 1-bit alpha) and a matching `.vmt`.

To use a spray, import the `.vtf` through TF2's spray import, or copy the `.vtf` and `.vmt`
into `tf/materials/vgui/logos/`.

## How it works

| File | Job |
|---|---|
| `src/decode.js`, `src/gif.js` | Decoding. GIFs use our own decoder, which matches Chrome's output pixel for pixel; other formats use the browser's `ImageDecoder` or `createImageBitmap`. |
| `src/plan.js` | Picks the size, frame count and fit. Pure functions, no browser needed. |
| `src/resample.js` | Catmull-Rom resizing with the filter widened when shrinking, so small mips don't alias. |
| `src/dxt1.js` | DXT1 encoder: principal-axis endpoints, least-squares refit, then a short search over the 565 endpoints. |
| `src/encoderPool.js`, `src/encoderWorker.js` | Resizes and encodes in Web Workers, split into strips so a single image uses every core. |
| `src/convert.js` | The pipeline, with progress and cancellation. |
| `src/vtf.js` | VTF header and VMT. |
| `src/App.jsx`, `src/useConversion.js` | The interface. Changing a setting cancels the running conversion and starts again. |

## Development

```sh
npm install
npm run dev          # local dev server
npm test             # unit tests (Vitest)
npm run lint
npm run build        # production build in dist/
npm run test-sprays  # diagnostic sprays for checking engine behaviour, in test-sprays/
```

## Credits

Earlier versions of the DXT1 encoder were adapted from
[dxtn](https://github.com/LordVonAdel/dxtn) and
[BCnEncoder.NET](https://github.com/Nominom/BCnEncoder.NET). The GIFs in `test/fixtures/skia`
are from [Skia](https://skia.org/) and used under its BSD licence.
