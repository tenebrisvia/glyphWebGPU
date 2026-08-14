# GlyphWebGPU

> **High-Performance WebGPU ASCII Glyph Rendering Engine**  
> Real-time conversion of 2D/3D canvases or direct coordinate-based instructions into animated ASCII glyph art.

---

## Overview

**GlyphWebGPU** is a zero-dependency, lightweight WebGPU rendering library designed for generative artists, game developers, and creative coders. It offers two distinct rendering modes:

1. **Canvas Mode (Sampling & Conversion)**: Samples an offscreen HTML `<canvas>` (2D context or 3D WebGL) every frame and maps pixel brightness to ASCII glyphs on the GPU. Supports both **custom palette mapping** and **Direct RGB Color Mode** (source canvas RGB directly colors glyphs).
2. **Instruction Mode (Direct Grid Updates)**: Directly updates individual grid cells `(x, y)` with character codes and custom foreground/background colors. Updates are cumulative and persist on the GPU across frames without clearing the rest of the grid.

Features CRT phosphor motion persistence and zero per-frame JavaScript garbage collection.

---

## Operating Modes

### 1. Canvas Mode
* **How it works**: Reads pixels from an offscreen `<canvas>` (e.g. p5.js 2D, 3D WebGL, or HTML5 `<video>`), calculates luminance in WGSL, and maps values to character codes and colors on the GPU.
* **Direct RGB Color Mode**: When passing `null` or `undefined` for `colourMapFG` in `setPalettes()`, the shader samples the source canvas RGB channels directly to colorize each foreground glyph with zero color quantization or fringing.
* **Best for**: 3D models, generative animations, video / webcam playback, and scenes where the entire frame changes continuously.
* **Examples in repo**:
  * [`examples/canvas_mode_2d.html`](./examples/canvas_mode_2d.html) — 2D p5.js generative orbiting circles in Direct RGB mode.
  * [`examples/canvas_mode_3d.html`](./examples/canvas_mode_3d.html) — 3D OBJ mesh with lighting, matrix transforms, and mouse/touch controls.
  * [`examples/canvas_mode_webcam.html`](./examples/canvas_mode_webcam.html) — Real-time webcam ASCII video stream with Direct RGB / B&W mode toggles.

### 2. Instruction Mode
* **How it works**: Operates without a source canvas. You push sparse updates `[{ x, y, charCode, fg, bg }]` to the grid staging buffer. Unmodified cells stay in GPU memory.
* **Best for**: Terminal emulators, particle systems, and UI overlays where only a subset of cells change each frame.
* **Examples in repo**:
  * [`examples/instruction_mode.html`](./examples/instruction_mode.html) — Particle simulation sending sparse coordinate updates.
  * [`examples/instruction_mode_windows.html`](./examples/instruction_mode_windows.html) — Retro green screen desktop with draggable ASCII terminal windows and 12x24 CP437 font atlas.

---

## Features

- **Direct RGB Color Mode**: Pass `null` for `colourMapFG` to allow source canvas 2D/3D colors to directly colorize rendered glyphs in real-time.
- **Single Fullscreen Triangle Pipeline**: Covers the viewport in 3 vertex invocations instead of thousands of quad instances, eliminating GPU vertex overhead and quad-overdraw.
- **CRT Phosphor Motion Decay**: Optional motion trail persistence (decay parameter toggles render pass `loadOp` between frame clearing when `0.0` and hardware accumulation when `> 0.0`).
- **Pixel-Exact Integer Texel Sampling**: Uses WGSL `textureLoad()` for direct texel fetches, avoiding floating-point UV interpolation and bilinear filtering blur.
- **Zero Per-Frame GC Overhead**: Pre-allocates GPU texture views and storage buffers during setup and resize events—zero JavaScript object allocations in the active render loop.
- **High-DPI & Mobile Touch Ready**: Automatic Retina (`devicePixelRatio`) resolution matching with full multi-touch gesture support (1-finger rotate, 2-finger pan, pinch-zoom).

---

## Repository Structure

```
.
├── examples/
│   ├── canvas_mode_2d.html           # 2D generative circles (Canvas Mode, Direct RGB)
│   ├── canvas_mode_3d.html           # 3D OBJ mesh renderer (Canvas Mode)
│   ├── canvas_mode_webcam.html       # Real-time webcam ASCII streamer (Canvas Mode)
│   ├── instruction_mode.html         # Particle simulation (Instruction Mode)
│   ├── instruction_mode_windows.html # Retro draggable windows (Instruction Mode)
│   ├── snag.obj                      # 3D OBJ model asset
│   └── snag.mtl                      # 3D Material definition
├── fonts/
│   ├── Amstrad_CPC_Full_AMSDOS_Character_Set.png  # 8x8 Pixel Font Atlas
│   └── cp437_12x24_atlas.png                     # 12x24 CP437 Font Atlas
├── thirdparty/
│   ├── p5.min.js                     # p5.js creative coding library
│   └── lil-gui.min.js                # lil-gui lightweight UI controls
└── glyphWebGPU.js                    # Core WebGPU ASCII Rendering Engine (MIT License)
```

---

## API Reference

### Initialization & Setup

#### `new GlyphWebGPU(sourceCanvas, targetCanvas, cols, rows, decay = 0.0)`
Creates a new instance in **Canvas Mode**.
```javascript
const renderer = new GlyphWebGPU(sourceCanvas, asciiCanvas, cols, rows, 0.08);
```
- `sourceCanvas` *(HTMLCanvasElement)*: The offscreen 2D or WebGL canvas containing source pixels.
- `targetCanvas` *(HTMLCanvasElement)*: The presentation canvas configured with WebGPU context.
- `cols` *(number)*: Number of ASCII grid columns.
- `rows` *(number)*: Number of ASCII grid rows.
- `decay` *(number|object)*: Phosphor motion decay factor (`0.0` = immediate clearing; `> 0.0` = hardware accumulation for CRT motion trails, e.g. `0.08` or `0.2`).

#### `GlyphWebGPU.Instructions(targetCanvas, cols, rows, decay = 0.0)`
Creates an instance in **Instruction Mode**.
```javascript
// Dedicated factory helper
const renderer = GlyphWebGPU.Instructions(asciiCanvas, cols, rows, 0.15);

// Or via configuration object
const renderer = new GlyphWebGPU({
    targetCanvas: asciiCanvas,
    cols: 80,
    rows: 40,
    mode: 'instructions',
    decay: 0.15
});
```

#### `loadGlyphsURL(url, mapWidth, mapHeight, width, height)`
Asynchronously loads the font glyph atlas PNG image.
```javascript
await renderer.loadGlyphsURL('../fonts/Amstrad_CPC_Full_AMSDOS_Character_Set.png', 128, 128, 8, 8);
```
- `url` *(string)*: Path to font atlas image.
- `mapWidth`, `mapHeight` *(number)*: Dimensions of font atlas image in pixels (e.g. `128, 128`).
- `width`, `height` *(number)*: Dimensions of individual glyph cells in pixels (e.g. `8, 8` or `12, 24`).

---

### Canvas Mode API

#### `setPalettes(charMap, colourMapFG, colourMapBG)`
Uploads character and color mapping tables to GPU storage buffers.

##### Direct RGB Mode (Source Canvas RGB Colors):
Pass `null` or `undefined` for `colourMapFG` to allow source canvas RGB pixels to directly colorize each glyph:
```javascript
// Direct RGB Mode: charMap maps luminance to character code, source canvas colors foreground
renderer.setPalettes(charMap, null, bgColors);
```

##### Custom Palette Mode:
Pass explicit interleaved color arrays:
```javascript
// charMap: Uint32/Float32Array(256) mapping luminance 0..255 to ASCII code
// colourMapFG / BG: Float32Array(256 * 4) interleaved [r, g, b, pad] in 0..1 range
renderer.setPalettes(charMap, colourMapFG, colourMapBG);
```
- `charMap` *(Float32Array)*: Array of 256 character codes indexed by luminance (`0..255`).
- `colourMapFG` *(Float32Array|null)*: Interleaved float array (4 floats per entry `[r, g, b, pad]` in `0..1` range) for text foreground colors, or `null` for Direct RGB mode.
- `colourMapBG` *(Float32Array)*: Interleaved float array (4 floats per entry `[r, g, b, pad]` in `0..1` range) for cell background colors.

#### `draw()`
Copies the current frame from `sourceCanvas` and renders the WebGPU ASCII presentation frame. Call this once per frame in your animation loop.
```javascript
renderer.draw();
```

---

### Instruction Mode API

#### `draw(instructions)` / `updateGlyphs(instructions)`
Applies an array of instruction objects (or a single instruction object) to the grid buffer and renders the frame. Unspecified cells remain unchanged.
```javascript
renderer.draw([
    {
        x: 10,
        y: 5,
        charCode: 65, // ASCII code or character 'A'
        fg: [1.0, 0.8, 0.2], // Normalized [r, g, b], 0..255 [r, g, b], hex '#ffcc33', or pre-packed uint32
        bg: [0.02, 0.02, 0.05]
    }
]);
```

#### `setCell(x, y, charCode, fg, bg)`
Updates a single grid cell directly on the CPU staging buffer without triggering an immediate draw.
```javascript
renderer.setCell(10, 5, '@', [0, 1, 0], [0, 0, 0]);
```

#### `clear(charCode = 32, fg = [1, 1, 1], bg = [0, 0, 0])`
Fills the entire instruction grid with the specified character and colors.
```javascript
renderer.clear(32, [1, 1, 1], [0.02, 0.02, 0.05]);
```

#### `clearRect(startX, startY, width, height, charCode = 32, fg = [1, 1, 1], bg = [0, 0, 0])`
Clears a rectangular region of grid cells.
```javascript
renderer.clearRect(0, 0, 20, 10, 32, [1, 1, 1], [0, 0, 0]);
```

#### `GlyphWebGPU.packColor(r, g, b, a = 1.0)`
Static helper to pre-pack RGB/RGBA colors into a 32-bit uint32 RGBA8 integer for zero-overhead instruction passing.
```javascript
const gold = GlyphWebGPU.packColor(1.0, 0.84, 0.0);
```

---

### Common API (Both Modes)

#### `resize(cols, rows)`
Dynamically re-allocates GPU target textures, grid buffers, and viewport parameters when the window or canvas dimensions change.
```javascript
renderer.resize(newCols, newRows);
```

#### `getGlyphData()`
Asynchronously extracts active non-space glyph cell states for export, CPU inspection, etc
```javascript
const { arr } = await glyphRenderer.getGlyphData();
// arr = [{ x, y, charCode, fg, bg, brightness }, ...]
```

#### `destroy()`
Cleanly releases and destroys all WebGPU textures, storage buffers, and GPU device resources.
```javascript
renderer.destroy();
```

---

## License

The **GlyphWebGPU** engine is open-source software licensed under the MIT License.
