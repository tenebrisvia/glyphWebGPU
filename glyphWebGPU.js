"use strict";

/**
 * GlyphWebGPU.js - High-Performance WebGPU ASCII Glyph Renderer
 *
 * MIT License
 *
 * Copyright (c) 2026 tenebris.via
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * @class GlyphWebGPU
 * @description
 * High-performance WebGPU ASCII glyph rendering engine for real-time generative art and 3D scenes.
 */
class GlyphWebGPU {
    static ARR_LEN = 256;

    /**
     * @param {HTMLCanvasElement} sourceCanvas - Offscreen 2D/WebGL source canvas containing input pixels.
     * @param {HTMLCanvasElement} targetCanvas - WebGPU canvas target for ASCII presentation.
     * @param {number} cols - Number of ASCII character grid columns.
     * @param {number} rows - Number of ASCII character grid rows.
     * @param {number|object} [decay=0.0] - Optional phosphor motion decay factor (0.0 = no decay, e.g. 0.22 = trail persistence).
     */
    constructor(sourceCanvas, targetCanvas, cols, rows, decay = 0.0) {
        let decayVal = 0.0;
        if (typeof decay === 'number') {
            decayVal = decay;
        } else if (decay && typeof decay.decay === 'number') {
            decayVal = decay.decay;
        }
        this._decay = decayVal;
        this._webGPU = {
            ready: false,
            device: null,
            context: null,
            render: {
                bindGroupLayout: null,
                bindGroup: null,
                pipelineLayout: null,
                pipeline: null
            }
        };

        // Source canvas (p5.js WebGL canvas texture)
        this._source = {
            canvas: sourceCanvas,
            texture: null
        };

        // Target presentation canvas details
        this._target = {
            canvas: targetCanvas,
            cols: cols,
            rows: rows,
            format: null,
            descriptor: null,
            persistentTexture: null,
            persistentTextureView: null
        };

        // Glyph atlas texture metadata
        this._glyph = {
            mapWidth: 0,
            mapHeight: 0,
            width: 0,
            height: 0,
            cols: 0,
            rows: 0,
            texture: null
        };

        // Palette mapping buffers (Luminance [0..255] -> Character / FG Color / BG Color)
        this._palettes = {
            charMap: null,
            charBuffer: null,
            colourMapFG: null,
            colourBufferFG: null,
            colourMapBG: null,
            colourBufferBG: null
        };

        // Backward compatibility mapping layer for legacy property setters
        this._instructions = {
            get maxlen() { return cols * rows; },
            get charMap() { return this._parent._palettes.charMap; },
            set charMap(val) { this._parent._palettes.charMap = val; },
            get colourMapFG() { return this._parent._palettes.colourMapFG; },
            set colourMapFG(val) { this._parent._palettes.colourMapFG = val; },
            get colourMapBG() { return this._parent._palettes.colourMapBG; },
            set colourMapBG(val) { this._parent._palettes.colourMapBG = val; },
            _parent: this
        };
    }

    /**
     * Updates character, foreground, and background color mapping palettes on GPU storage buffers.
     * @param {Float32Array} charMap - Array of 256 ASCII character codes indexed by luminance.
     * @param {Float32Array} colourMapFG - Interleaved RGBA float values (0..1) for foreground text colors.
     * @param {Float32Array} colourMapBG - Interleaved RGBA float values (0..1) for cell background colors.
     */
    setPalettes(charMap, colourMapFG, colourMapBG) {
        this._palettes.charMap = charMap;
        this._palettes.colourMapFG = colourMapFG;
        this._palettes.colourMapBG = colourMapBG;

        if (this._webGPU.ready) {
            this._uploadPalettes();
        }
    }

    /**
     * Asynchronously loads a font glyph atlas image URL and initializes hardware GPU textures.
     * @param {string} url - URL path to the font atlas PNG image.
     * @param {number} mapWidth - Width of font atlas image in pixels (e.g. 128).
     * @param {number} mapHeight - Height of font atlas image in pixels (e.g. 128).
     * @param {number} width - Individual character width in pixels (e.g. 8).
     * @param {number} height - Individual character height in pixels (e.g. 8).
     */
    async loadGlyphsURL(url, mapWidth, mapHeight, width, height) {
        const img = new Image();
        img.src = url;
        await img.decode();
        const bitmap = await createImageBitmap(img);
        await this._loadGlyphs(bitmap, mapWidth, mapHeight, width, height);
    }

    async _loadGlyphs(bitmap, mapWidth, mapHeight, width, height) {
        this._glyph.mapWidth = mapWidth;
        this._glyph.mapHeight = mapHeight;
        this._glyph.width = width;
        this._glyph.height = height;
        this._glyph.cols = Math.floor(mapWidth / width);
        this._glyph.rows = Math.floor(mapHeight / height);

        await this._setupGPU(bitmap);
    }

    /**
     * Requests GPUAdapter and GPUDevice, configures WebGPU canvas context, and constructs pipeline.
     */
    async _setupGPU(glyphBitmap) {
        if (!navigator.gpu) {
            throw new Error('WebGPU is not supported on this browser');
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error('No appropriate GPUAdapter found');
        }

        this._webGPU.device = await adapter.requestDevice();

        // Device loss event handling (handles laptop sleep/wake, driver resets)
        this._webGPU.device.lost.then((info) => {
            console.warn(`WebGPU device was lost: ${info.message}`);
            this._webGPU.ready = false;
        });

        this._webGPU.context = this._target.canvas.getContext('webgpu');
        this._target.format = navigator.gpu.getPreferredCanvasFormat();

        this._webGPU.context.configure({
            device: this._webGPU.device,
            format: this._target.format,
            sampleCount: 1,
            alphaMode: 'opaque',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
        });

        this._glyphBitmap = glyphBitmap;
        this._setupGPU_BuffersAndTextures(glyphBitmap);
        this._setupGPU_RenderModule();

        this._webGPU.ready = true;
    }

    /**
     * Dynamic resize handler for window resize and mobile orientation changes.
     * Reallocates target textures, updates viewport parameters, and rebuilds pipeline layout.
     * @param {number} cols - New ASCII column count.
     * @param {number} rows - New ASCII row count.
     */
    resize(cols, rows) {
        if (!this._webGPU.ready || (this._target.cols === cols && this._target.rows === rows)) return;

        this._target.cols = cols;
        this._target.rows = rows;

        if (this._source.texture) this._source.texture.destroy();
        if (this._target.persistentTexture) this._target.persistentTexture.destroy();

        const device = this._webGPU.device;

        this._webGPU.context.configure({
            device: device,
            format: this._target.format,
            sampleCount: 1,
            alphaMode: 'opaque',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
        });

        this._source.texture = device.createTexture({
            label: '_source.texture',
            size: [this._target.cols, this._target.rows],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });

        this._target.persistentTexture = device.createTexture({
            label: '_target.persistentTexture',
            size: [this._target.canvas.width, this._target.canvas.height],
            format: this._target.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        });

        this._target.persistentTextureView = this._target.persistentTexture.createView({ dimension: '2d' });
        this._target.descriptor.colorAttachments[0].view = this._target.persistentTextureView;
        this._target.descriptor.colorAttachments[0].loadOp = 'clear';

        this._setupGPU_RenderModule();
    }

    _uploadPalettes() {
        if (this._palettes.charMap && this._palettes.charBuffer) {
            this._webGPU.device.queue.writeBuffer(this._palettes.charBuffer, 0, this._palettes.charMap);
        }
        if (this._palettes.colourMapFG && this._palettes.colourBufferFG) {
            this._webGPU.device.queue.writeBuffer(this._palettes.colourBufferFG, 0, this._palettes.colourMapFG);
        }
        if (this._palettes.colourMapBG && this._palettes.colourBufferBG) {
            this._webGPU.device.queue.writeBuffer(this._palettes.colourBufferBG, 0, this._palettes.colourMapBG);
        }
    }

    _setupGPU_BuffersAndTextures(glyphBitmap) {
        const device = this._webGPU.device;

        // Source canvas texture (copied from p5 WebGL source canvas)
        this._source.texture = device.createTexture({
            label: '_source.texture',
            size: [this._target.cols, this._target.rows],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });

        // Storage buffers for character index and color lookup tables
        const charMapLength = (this._palettes.charMap ? this._palettes.charMap.length : GlyphWebGPU.ARR_LEN) * 4;
        const colMapFGLength = (this._palettes.colourMapFG ? this._palettes.colourMapFG.length : GlyphWebGPU.ARR_LEN * 4) * 4;
        const colMapBGLength = (this._palettes.colourMapBG ? this._palettes.colourMapBG.length : GlyphWebGPU.ARR_LEN * 4) * 4;

        this._palettes.charBuffer = device.createBuffer({
            label: '_palettes.charBuffer',
            size: charMapLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        this._palettes.colourBufferFG = device.createBuffer({
            label: '_palettes.colourBufferFG',
            size: colMapFGLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        this._palettes.colourBufferBG = device.createBuffer({
            label: '_palettes.colourBufferBG',
            size: colMapBGLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        this._uploadPalettes();

        // Persistent target texture for phosphor burn-in / motion decay blending
        this._target.persistentTexture = device.createTexture({
            label: '_target.persistentTexture',
            size: [this._target.canvas.width, this._target.canvas.height],
            format: this._target.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        });

        // Cached texture view (eliminates per-frame JS object allocations)
        this._target.persistentTextureView = this._target.persistentTexture.createView({ dimension: '2d' });

        this._target.descriptor = {
            colorAttachments: [{
                view: this._target.persistentTextureView,
                clearValue: [0, 0, 0, 1],
                loadOp: 'clear',
                storeOp: 'store'
            }]
        };

        // Hardware font atlas texture
        this._glyph.texture = device.createTexture({
            label: '_glyph.texture',
            size: [this._glyph.mapWidth, this._glyph.mapHeight],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });

        device.queue.copyExternalImageToTexture(
            { source: glyphBitmap },
            { texture: this._glyph.texture },
            [this._glyph.mapWidth, this._glyph.mapHeight]
        );
    }

    _setupGPU_RenderModule() {
        const device = this._webGPU.device;

        // WGSL Shader Module Definition
        const shaderCode = `
            const glyphWidth: u32 = ${this._glyph.width}u;
            const glyphHeight: u32 = ${this._glyph.height}u;
            const glyphCols: u32 = ${this._glyph.cols}u;
            const maxCols: u32 = ${this._target.cols}u;
            const maxRows: u32 = ${this._target.rows}u;
            const decayFactor: f32 = ${this._decay.toFixed(4)};

            @group(0) @binding(0) var inputCanvas: texture_2d<f32>;
            @group(0) @binding(1) var<storage, read> charMap: array<f32>;
            @group(0) @binding(2) var<storage, read> colourMapFG: array<vec4f>;
            @group(0) @binding(3) var<storage, read> colourMapBG: array<vec4f>;
            @group(0) @binding(4) var inputAtlas: texture_2d<f32>;

            // 1 Fullscreen Triangle covering NDC bounds [-1, 1]. Total 3 vertex invocations.
            @vertex fn vertexShader(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
                var pos = array<vec2f, 3>(
                    vec2f(-1.0, -1.0),
                    vec2f( 3.0, -1.0),
                    vec2f(-1.0,  3.0)
                );
                return vec4f(pos[vertexIndex], 0.0, 1.0);
            }

            @fragment fn fragmentShader(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
                let pixelX = u32(fragCoord.x);
                let pixelY = u32(fragCoord.y);

                // Map window pixel coordinate to ASCII grid cell index
                let cellX = pixelX / glyphWidth;
                let cellY = pixelY / glyphHeight;

                if (cellX >= maxCols || cellY >= maxRows) {
                    return vec4f(0.0, 0.0, 0.0, 1.0);
                }

                // Sample source canvas color directly at grid cell coordinates
                let colour = textureLoad(inputCanvas, vec2u(cellX, cellY), 0u);
                
                // Perceptual luminance calculation (ITU-R BT.709 standards)
                let luma = clamp(dot(colour.rgb, vec3f(0.213, 0.715, 0.072)), 0.0, 1.0);
                let brightness = u32(luma * 255.0);

                let charCode = u32(charMap[brightness]);
                let fg = colourMapFG[brightness].rgb;
                let bg = colourMapBG[brightness].rgb;

                // Relative pixel offset inside character cell
                let glyphLocalX = pixelX % glyphWidth;
                let glyphLocalY = pixelY % glyphHeight;

                // Atlas cell grid coordinates
                let atlasCellX = charCode % glyphCols;
                let atlasCellY = charCode / glyphCols;

                let atlasPixel = vec2u(
                    atlasCellX * glyphWidth + glyphLocalX,
                    atlasCellY * glyphHeight + glyphLocalY
                );

                // Pixel-exact integer texel fetch from font atlas (zero filtering blur)
                let s = textureLoad(inputAtlas, atlasPixel, 0u);
                let color = mix(bg, fg, s.rgb);

                // Phosphor persistence decay: s.r=1 (text) -> alpha 1.0; s.r=0 (bg) -> alpha decayFactor
                let alpha = mix(decayFactor, 1.0, s.r);

                return vec4f(color, alpha);
            }
        `;

        const renderModule = device.createShaderModule({
            label: 'renderModule',
            code: shaderCode
        });

        this._webGPU.render.bindGroupLayout = device.createBindGroupLayout({
            label: '_renderBindGroupLayout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {}
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' }
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' }
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {}
                }
            ]
        });

        this._webGPU.render.pipelineLayout = device.createPipelineLayout({
            label: '_renderPipelineLayout',
            bindGroupLayouts: [this._webGPU.render.bindGroupLayout]
        });

        this._webGPU.render.pipeline = device.createRenderPipeline({
            label: '_renderPipeline',
            layout: this._webGPU.render.pipelineLayout,
            vertex: {
                module: renderModule,
                entryPoint: 'vertexShader'
            },
            fragment: {
                module: renderModule,
                entryPoint: 'fragmentShader',
                targets: [{
                    format: this._target.format,
                    sampleCount: 1,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        }
                    }
                }]
            },
            primitive: {
                topology: 'triangle-list'
            },
            multisample: {
                count: 1
            }
        });

        this._webGPU.render.bindGroup = device.createBindGroup({
            label: '_renderBindGroup',
            layout: this._webGPU.render.bindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this._source.texture.createView({ dimension: '2d' })
                },
                {
                    binding: 1,
                    resource: { buffer: this._palettes.charBuffer }
                },
                {
                    binding: 2,
                    resource: { buffer: this._palettes.colourBufferFG }
                },
                {
                    binding: 3,
                    resource: { buffer: this._palettes.colourBufferBG }
                },
                {
                    binding: 4,
                    resource: this._glyph.texture.createView({ dimension: '2d' })
                }
            ]
        });
    }

    _render() {
        const copyW = Math.min(this._target.cols, this._source.canvas.width);
        const copyH = Math.min(this._target.rows, this._source.canvas.height);

        if (copyW <= 0 || copyH <= 0) return;

        // Copy latest p5 canvas content to WebGPU source texture
        this._webGPU.device.queue.copyExternalImageToTexture(
            { source: this._source.canvas },
            { texture: this._source.texture },
            [copyW, copyH]
        );

        const encoder = this._webGPU.device.createCommandEncoder();

        // 1 Fullscreen Triangle Render Pass
        const renderPass = encoder.beginRenderPass(this._target.descriptor);
        renderPass.setPipeline(this._webGPU.render.pipeline);
        renderPass.setBindGroup(0, this._webGPU.render.bindGroup);
        renderPass.draw(3, 1);
        renderPass.end();

        // Only preserve previous frame contents for burn-in decay if decay > 0.0
        if (this._decay > 0.0) {
            this._target.descriptor.colorAttachments[0].loadOp = 'load';
        } else {
            this._target.descriptor.colorAttachments[0].loadOp = 'clear';
        }

        // Blit persistent texture to presentation canvas
        encoder.copyTextureToTexture(
            { texture: this._target.persistentTexture },
            { texture: this._webGPU.context.getCurrentTexture() },
            [this._target.canvas.width, this._target.canvas.height]
        );

        this._webGPU.device.queue.submit([encoder.finish()]);
    }

    /**
     * Synchronously renders the latest frame from the source canvas to the ASCII target canvas.
     */
    draw() {
        if (!this._webGPU.ready) return;
        this._render();
    }

    /**
     * On-demand glyph extraction for SVG vector export.
     * Supports both WebGL and 2D source canvas contexts.
     * Executes CPU pixel extraction only when called (zero per-frame render overhead).
     * @returns {Promise<{arr: Array<{x: number, y: number, charCode: number, brightness: number}>}>}
     */
    async getGlyphData() {
        const cols = this._target.cols;
        const rows = this._target.rows;
        const gl = this._source.canvas.getContext('webgl2') || this._source.canvas.getContext('webgl');
        const ctx2d = !gl ? this._source.canvas.getContext('2d') : null;

        let pixels;
        if (gl) {
            pixels = new Uint8Array(cols * rows * 4);
            gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        } else if (ctx2d) {
            pixels = ctx2d.getImageData(0, 0, cols, rows).data;
        } else {
            return { arr: [] };
        }

        const charMap = this._palettes.charMap;
        const arr = [];

        for (let y = 0; y < rows; y++) {
            // WebGL readPixels has bottom-left origin; 2D canvas has top-left origin
            const srcY = gl ? (rows - 1 - y) : y;
            for (let x = 0; x < cols; x++) {
                const idx = (srcY * cols + x) * 4;
                const r = pixels[idx] / 255.0;
                const g = pixels[idx + 1] / 255.0;
                const b = pixels[idx + 2] / 255.0;
                const luma = Math.min(Math.max(0.213 * r + 0.715 * g + 0.072 * b, 0.0), 1.0);
                const brightness = Math.min(Math.max(Math.floor(luma * 255.0), 0), 255);
                const charCode = charMap ? charMap[brightness] : 32;

                if (charCode !== 32) {
                    arr.push({ x, y, charCode, brightness });
                }
            }
        }

        return { arr };
    }

    /**
     * Cleanly releases and destroys all WebGPU textures, buffers, and device resources.
     */
    destroy() {
        this._webGPU.ready = false;
        if (this._source.texture) this._source.texture.destroy();
        if (this._target.persistentTexture) this._target.persistentTexture.destroy();
        if (this._glyph.texture) this._glyph.texture.destroy();
        if (this._palettes.charBuffer) this._palettes.charBuffer.destroy();
        if (this._palettes.colourBufferFG) this._palettes.colourBufferFG.destroy();
        if (this._palettes.colourBufferBG) this._palettes.colourBufferBG.destroy();
        if (this._webGPU.device) this._webGPU.device.destroy();
    }
}