# GlyphWebGPU

> **High-Performance WebGPU ASCII Glyph Rendering Engine**  
> Real-time conversion of 2D/3D canvases into animated ASCII glyph art powered by WebGPU WGSL shaders.

---

## Overview

**GlyphWebGPU** is a zero-dependency, lightweight WebGPU rendering library designed for generative artists and creative developers. It takes any offscreen HTML `<canvas>` (2D or 3D WebGL) and renders it as an ASCII character display in real-time.

It features **CRT phosphor motion persistence**, **integer texel sampling**, **zero per-frame garbage collection**.

---

## Features

- **Single Fullscreen Triangle Pipeline**: Covers the viewport in 3 vertex invocations instead of thousands of quad instances, eliminating GPU vertex overhead and quad-overdraw.
- **CRT Phosphor Motion Decay**: Optional motion trail persistence (decay parameter toggles render pass `loadOp` between frame clearing when `0.0` and hardware accumulation when `> 0.0`).
- **Pixel-Exact Integer Texel Sampling**: Uses WGSL `textureLoad()` for direct texel fetches, avoiding floating-point UV interpolation and bilinear filtering blur.
- **Zero Per-Frame GC Overhead**: Pre-allocates GPU texture views and storage buffers during setup and resize events—zero JavaScript object allocations in the active render loop.
- **High-DPI & Mobile Touch Ready**: Automatic Retina (`devicePixelRatio`) resolution matching with full multi-touch gesture support (1-finger rotate, 2-finger pan, pinch-zoom).
- **SVG Vector Art Exporter**: On-demand CPU/GPU texel state extraction for downloading resolution-independent vector graphics.

---

## Quick Start (Basic 2D Example)

Below is a minimal example using **p5.js** in 2D mode with `GlyphWebGPU`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>GlyphWebGPU - Basic Example</title>
    <style>
        body { margin: 0; background: #000; overflow: hidden; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        canvas { display: block; image-rendering: pixelated; touch-action: none; }
        #sourceCanvas { display: none; }
    </style>
    <script src="./p5.min.js"></script>
    <script src="./glyphWebGPU.js"></script>
</head>
<body>
    <canvas id="sourceCanvas"></canvas>
    <canvas id="asciiCanvas"></canvas>

    <script>
        const charWidth = 8, charHeight = 8;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        let cols = Math.floor(window.innerWidth * dpr / charWidth);
        let rows = Math.floor(window.innerHeight * dpr / charHeight);

        const sourceCanvas = document.getElementById('sourceCanvas');
        const asciiCanvas = document.getElementById('asciiCanvas');
        asciiCanvas.width = cols * charWidth;
        asciiCanvas.height = rows * charHeight;

        let glyphRenderer = null;

        async function setup() {
            pixelDensity(1);
            createCanvas(cols, rows, P2D, sourceCanvas);

            // 1. Initialize Engine
            glyphRenderer = new GlyphWebGPU(sourceCanvas, asciiCanvas, cols, rows);

            // 2. Build Luminance-to-ASCII Character Ramp (0..255 -> ASCII code)
            const charMap = new Float32Array(256);
            const ramp = [32, 46, 58, 45, 61, 43, 42, 35, 37, 64]; // " .:-=*+#%@"
            for (let i = 0; i < 256; i++) {
                charMap[i] = ramp[Math.floor((i / 256) * ramp.length)];
            }

            // 3. Build Interleaved RGBA Color Palettes (0..1 floats)
            const fgColors = new Float32Array(256 * 4);
            const bgColors = new Float32Array(256 * 4);
            for (let i = 0; i < 256; i++) {
                const t = i / 255.0;
                fgColors[i * 4 + 0] = Math.sin(t * Math.PI); // R
                fgColors[i * 4 + 1] = 1.0 - t;              // G
                fgColors[i * 4 + 2] = t;                    // B
                fgColors[i * 4 + 3] = 1.0;                  // A

                bgColors[i * 4 + 0] = 0.02; bgColors[i * 4 + 1] = 0.02; bgColors[i * 4 + 2] = 0.05; bgColors[i * 4 + 3] = 1.0;
            }

            glyphRenderer.setPalettes(charMap, fgColors, bgColors);

            // 4. Load Character Atlas PNG
            await glyphRenderer.loadGlyphsURL('./Amstrad_CPC_Full_AMSDOS_Character_Set.png', 128, 128, 8, 8);
        }

        function draw() {
            // Draw 2D p5 graphics
            background(0);
            fill(255);
            noStroke();
            const t = millis() * 0.002;
            ellipse(cols / 2 + Math.cos(t) * 20, rows / 2 + Math.sin(t) * 20, 30, 30);

            // Render WebGPU ASCII Frame
            if (glyphRenderer) glyphRenderer.draw();
        }

        function windowResized() {
            cols = Math.floor(window.innerWidth * dpr / charWidth);
            rows = Math.floor(window.innerHeight * dpr / charHeight);
            asciiCanvas.width = cols * charWidth; asciiCanvas.height = rows * charHeight;
            resizeCanvas(cols, rows);
            if (glyphRenderer) glyphRenderer.resize(cols, rows);
        }
    </script>
</body>
</html>
```

---

## Repository Structure

```
.
├── example_basic.html                        # Minimal 2D p5.js example
├── index.html                                # Interactive 3D procedural liquid blob WebGL demo
├── main.js                                   # Procedural 3D scene controller, touch physics & SVG exporter
├── glyphWebGPU.js                            # Core WebGPU ASCII Rendering Engine (MIT License)
└── Amstrad_CPC_Full_AMSDOS_Character_Set.png # 8x8 Pixel Font Atlas
```

---

## API Reference

### `new GlyphWebGPU(sourceCanvas, targetCanvas, cols, rows, decay = 0.0)`
Creates a new instance of the WebGPU ASCII renderer.
- `sourceCanvas` *(HTMLCanvasElement)*: The offscreen 2D or WebGL canvas containing source pixels.
- `targetCanvas` *(HTMLCanvasElement)*: The presentation canvas configured with WebGPU context.
- `cols` *(number)*: Number of ASCII grid columns.
- `rows` *(number)*: Number of ASCII grid rows.
- `decay` *(number|object)*: Optional phosphor motion decay factor (defaults to `0.0` for zero trail persistence with frame clearing; values `> 0.0` enable hardware accumulation for smooth CRT motion trails, e.g. `0.08` or `0.2`).

---

### `loadGlyphsURL(url, mapWidth, mapHeight, width, height)`
Asynchronously loads the font glyph atlas PNG image.
- `url` *(string)*: Path to font atlas image.
- `mapWidth`, `mapHeight` *(number)*: Dimensions of font atlas image in pixels (e.g. `128, 128`).
- `width`, `height` *(number)*: Dimensions of individual glyph cells in pixels (e.g. `8, 8`).

---

### `setPalettes(charMap, colourMapFG, colourMapBG)`
Uploads custom character and color mapping tables to GPU storage buffers.
- `charMap` *(Float32Array)*: Array of 256 character codes indexed by luminance (`0..255`).
- `colourMapFG` *(Float32Array)*: Interleaved RGBA float values (`0..1`) for text foreground colors.
- `colourMapBG` *(Float32Array)*: Interleaved RGBA float values (`0..1`) for cell background colors.

---

### `draw()`
Copies the current frame from `sourceCanvas` and renders the WebGPU ASCII presentation frame. Call this once per frame in your requestAnimationFrame or p5 `draw()` loop.

---

### `resize(cols, rows)`
Re-configures GPU target textures and WGSL constants when the window or canvas grid dimensions change.

---

### `getGlyphData()`
Returns an asynchronous Promise resolving to an array of active non-space glyph cell states for SVG vector generation (supports both 2D and WebGL source canvas contexts):
```javascript
const { arr } = await glyphRenderer.getGlyphData();
// arr = [{ x, y, charCode, brightness }, ...]
```

---

### `destroy()`
Cleanly releases and destroys all WebGPU textures, storage buffers, and GPU device handles when unmounting scenes or switching render targets.

---

## License

The **GlyphWebGPU** engine is open-source software licensed under the MIT License.
