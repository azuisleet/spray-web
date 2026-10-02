GIFs from Skia's test resources (`resources/images`), used under the BSD licence in
`LICENSE`. They cover every disposal mode, interlacing, frames larger than the canvas,
an empty logical screen, palette indices past the end of the palette, and transparency.

The expected frame hashes in `test/gif.test.js` were taken from our decoder after its
output was confirmed identical, pixel for pixel, to Chrome's ImageDecoder on every frame.
