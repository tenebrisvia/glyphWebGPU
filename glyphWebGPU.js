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
 * Fast helper to pack color inputs (array [r,g,b,a], object {r,g,b,a}, or hex string "#ff0000")
 * into a single 32-bit uint32 RGBA8 bitmask (Little-Endian layout for WGSL unpack4x8unorm).
 * Zero heap allocations.
 */
function _packGlyphColorRGBA8(colorInput, defaultPacked = 0xFFFFFFFF) {
    if (colorInput === null || colorInput === undefined) return defaultPacked;
    if (typeof colorInput === 'number') return colorInput >>> 0;

    let r = 255, g = 255, b = 255, a = 255;

    if (Array.isArray(colorInput)) {
        r = colorInput[0] ?? 255;
        g = colorInput[1] ?? 255;
        b = colorInput[2] ?? 255;
        const hasA = colorInput.length > 3 && colorInput[3] !== undefined;
        a = hasA ? colorInput[3] : (r <= 1.0 && g <= 1.0 && b <= 1.0 ? 1.0 : 255);
        if (r <= 1.0 && g <= 1.0 && b <= 1.0 && a <= 1.0) {
            r = Math.round(r * 255);
            g = Math.round(g * 255);
            b = Math.round(b * 255);
            a = Math.round(a * 255);
        }
    } else if (typeof colorInput === 'object') {
        r = colorInput.r ?? 255;
        g = colorInput.g ?? 255;
        b = colorInput.b ?? 255;
        const hasA = colorInput.a !== undefined;
        a = hasA ? colorInput.a : (r <= 1.0 && g <= 1.0 && b <= 1.0 ? 1.0 : 255);
        if (r <= 1.0 && g <= 1.0 && b <= 1.0 && a <= 1.0) {
            r = Math.round(r * 255);
            g = Math.round(g * 255);
            b = Math.round(b * 255);
            a = Math.round(a * 255);
        }
    } else if (typeof colorInput === 'string' && colorInput.startsWith('#')) {
        let hex = colorInput.slice(1);
        if (hex.length === 3) {
            hex = hex.split('').map(x => x + x).join('');
        }
        if (hex.length === 6 || hex.length === 8) {
            const num = parseInt(hex, 16);
            if (hex.length === 8) {
                r = (num >> 24) & 255;
                g = (num >> 16) & 255;
                b = (num >> 8) & 255;
                a = num & 255;
            } else {
                r = (num >> 16) & 255;
                g = (num >> 8) & 255;
                b = num & 255;
                a = 255;
            }
        }
    }

    r = Math.min(Math.max(0, Math.floor(r)), 255);
    g = Math.min(Math.max(0, Math.floor(g)), 255);
    b = Math.min(Math.max(0, Math.floor(b)), 255);
    a = Math.min(Math.max(0, Math.floor(a)), 255);

    // Little endian uint32 RGBA8 packing for WGSL unpack4x8unorm
    return (r) | (g << 8) | (b << 16) | (a << 24);
}

/**
 * Unpacks uint32 RGBA8 packed color into normalized float array [r, g, b, a] (0..1).
 */
function _unpackGlyphColorRGBA8(packed) {
    const r = (packed & 255) / 255.0;
    const g = ((packed >> 8) & 255) / 255.0;
    const b = ((packed >> 16) & 255) / 255.0;
    const a = ((packed >> 24) & 255) / 255.0;
    return [r, g, b, a];
}

/**
 * @class GlyphWebGPU
 * @description
 * High-performance WebGPU ASCII glyph rendering engine for real-time generative art, 3D scenes,
 * and sparse cumulative instruction-based terminal/ASCII applications.
 */
class GlyphWebGPU {
    static ARR_LEN = 256;

    /**
     * Supports two constructor signatures:
     * 
     * Signature 1 (Canvas Mode - Backward Compatible):
     * @param {HTMLCanvasElement} sourceCanvas - Offscreen 2D/WebGL source canvas containing input pixels.
     * @param {HTMLCanvasElement} targetCanvas - WebGPU canvas target for ASCII presentation.
     * @param {number} cols - Number of ASCII character grid columns.
     * @param {number} rows - Number of ASCII character grid rows.
     * @param {number|object} [decay=0.0] - Optional phosphor motion decay factor (0.0 = no decay).
     * 
     * Signature 2 (Config Object - Canvas or Instructions Mode):
     * @param {object} config - Configuration object { targetCanvas, cols, rows, mode: 'canvas'|'instructions', sourceCanvas, decay }
     */
    constructor(sourceCanvas, targetCanvas, cols, rows, decay = 0.0) {
        let mode = 'canvas';
        let srcCanvas = null;
        let tgtCanvas = null;
        let numCols = 0;
        let numRows = 0;
        let decayVal = 0.0;

        if (sourceCanvas && typeof sourceCanvas === 'object' && !sourceCanvas.getContext) {
            const config = sourceCanvas;
            tgtCanvas = config.targetCanvas;
            numCols = config.cols;
            numRows = config.rows;
            mode = config.mode || (config.sourceCanvas ? 'canvas' : 'instructions');
            srcCanvas = config.sourceCanvas || null;
            if (typeof config.decay === 'number') decayVal = config.decay;
            else if (config.decay && typeof config.decay.decay === 'number') decayVal = config.decay.decay;
        } else {
            srcCanvas = sourceCanvas;
            tgtCanvas = targetCanvas;
            numCols = cols;
            numRows = rows;
            mode = 'canvas';
            if (typeof decay === 'number') decayVal = decay;
            else if (decay && typeof decay.decay === 'number') decayVal = decay.decay;
        }

        this._mode = mode; // 'canvas' or 'instructions'
        this._decay = decayVal;

        this._webGPU = {
            ready: false,
            device: null,
            context: null,
            paramsBuffer: null,
            render: {
                bindGroupLayout: null,
                bindGroup: null,
                pipelineLayout: null,
                pipeline: null
            }
        };

        // Target presentation canvas details
        this._target = {
            canvas: tgtCanvas,
            cols: numCols,
            rows: numRows,
            format: null,
            descriptor: null,
            persistentTexture: null,
            persistentTextureView: null
        };

        // Source canvas (p5.js WebGL canvas texture for Canvas mode)
        this._source = {
            canvas: srcCanvas,
            texture: null
        };

        this._useCanvasColor = false;

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

        // Mode 1: Palette mapping buffers (Canvas Mode)
        this._palettes = {
            charMap: null,
            charBuffer: null,
            colourMapFG: null,
            colourBufferFG: null,
            colourMapBG: null,
            colourBufferBG: null
        };

        // Mode 2: Instruction Grid Buffers (Instruction Mode)
        // High-Performance Packed Storage: Each cell = 4 uint32s (16 bytes): [charCode, packedFG_RGBA8, packedBG_RGBA8, pad]
        this._instructionGrid = {
            data: null,      // Uint32Array (size = cols * rows * 4)
            buffer: null,    // GPUStorageBuffer
            dirty: false,
            minDirtyIdx: 0,
            maxDirtyIdx: 0
        };

        if (this._mode === 'instructions') {
            this._initInstructionGrid(numCols, numRows);
        }

        // Backward compatibility mapping layer for legacy property setters
        this._instructions = {
            get maxlen() { return numCols * numRows; },
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
     * Dedicated factory/constructor for Instruction-Based rendering mode.
     */
    static Instructions(targetCanvas, cols, rows, decay = 0.0) {
        return new GlyphWebGPU({
            targetCanvas: targetCanvas,
            cols: cols,
            rows: rows,
            mode: 'instructions',
            decay: decay
        });
    }

    /**
     * Initializes or re-allocates the Uint32Array staging data array for Instruction Mode grid storage (16 bytes/cell).
     */
    _initInstructionGrid(cols, rows) {
        const totalCells = cols * rows;
        const uintsPerCell = 4;
        const totalUints = totalCells * uintsPerCell;

        const oldData = this._instructionGrid.data;
        const newData = new Uint32Array(totalUints);

        // Pre-fill with empty cells (space=32, white FG, transparent/black BG)
        const defaultFG = 0xFFFFFFFF; // packed opaque white
        const defaultBG = 0xFF000000; // packed opaque black
        for (let i = 0; i < totalCells; i++) {
            newData[i * uintsPerCell] = 32;
            newData[i * uintsPerCell + 1] = defaultFG;
            newData[i * uintsPerCell + 2] = defaultBG;
            newData[i * uintsPerCell + 3] = 0;
        }

        // Preserve previous cell content if resizing
        if (oldData) {
            const copyLen = Math.min(oldData.length, totalUints);
            for (let i = 0; i < copyLen; i += uintsPerCell) {
                if (oldData[i] !== 32 || oldData[i + 1] !== defaultFG || oldData[i + 2] !== defaultBG) {
                    newData[i] = oldData[i];
                    newData[i + 1] = oldData[i + 1];
                    newData[i + 2] = oldData[i + 2];
                }
            }
        }

        this._instructionGrid.data = newData;
        this._instructionGrid.dirty = true;
        this._instructionGrid.minDirtyIdx = 0;
        this._instructionGrid.maxDirtyIdx = totalCells - 1;
    }

    /**
     * Updates character, foreground, and background color mapping palettes on GPU storage buffers (Canvas Mode).
     * If colourMapFG is null or omitted, direct RGB color mode is enabled (source canvas RGB drives foreground color directly).
     */
    setPalettes(charMap, colourMapFG, colourMapBG) {
        this._palettes.charMap = charMap;
        this._palettes.colourMapFG = colourMapFG || null;
        this._palettes.colourMapBG = colourMapBG || null;
        this._useCanvasColor = (colourMapFG === null || colourMapFG === undefined);

        if (this._webGPU.ready && this._mode === 'canvas') {
            this._updateParamsBuffer();
            this._uploadPalettes();
        }
    }

    /**
     * Asynchronously loads a font glyph atlas image URL and initializes hardware GPU textures.
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
     * Updates uniform buffer holding grid size, glyph dimensions, and motion decay parameters.
     */
    _updateParamsBuffer() {
        if (!this._webGPU.device || !this._webGPU.paramsBuffer) return;

        // Uniform Buffer Layout (32 bytes):
        // [0]: glyphWidth (u32), [1]: glyphHeight (u32), [2]: glyphCols (u32), [3]: maxCols (u32)
        // [4]: maxRows (u32), [5]: decayFactor (f32), [6]: pad, [7]: pad
        const buffer = new ArrayBuffer(32);
        const u32View = new Uint32Array(buffer);
        const f32View = new Float32Array(buffer);

        u32View[0] = this._glyph.width;
        u32View[1] = this._glyph.height;
        u32View[2] = this._glyph.cols;
        u32View[3] = this._target.cols;
        u32View[4] = this._target.rows;
        f32View[5] = this._decay;
        u32View[6] = this._useCanvasColor ? 1 : 0;

        this._webGPU.device.queue.writeBuffer(this._webGPU.paramsBuffer, 0, buffer);
    }

    /**
     * Dynamic resize handler for window resize and mobile orientation changes.
     * Reallocates target textures and updates viewport parameters without recompiling pipelines.
     */
    resize(cols, rows) {
        if (!this._webGPU.ready || (this._target.cols === cols && this._target.rows === rows)) return;

        this._target.cols = cols;
        this._target.rows = rows;

        if (this._mode === 'instructions') {
            this._initInstructionGrid(cols, rows);
        }

        this._updateCanvasResolution();
    }

    _updateCanvasResolution() {
        const device = this._webGPU.device;
        if (!device) return;

        this._webGPU.context.configure({
            device: device,
            format: this._target.format,
            sampleCount: 1,
            alphaMode: 'opaque',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
        });

        if (this._mode === 'canvas') {
            if (this._source.texture) this._source.texture.destroy();
            this._source.texture = device.createTexture({
                label: '_source.texture',
                size: [this._target.cols, this._target.rows],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
            });
        } else if (this._mode === 'instructions') {
            if (this._instructionGrid.buffer) {
                this._instructionGrid.buffer.destroy();
                this._instructionGrid.buffer = null;
            }
            const bufferSize = this._instructionGrid.data.byteLength;
            this._instructionGrid.buffer = device.createBuffer({
                label: '_instructionGrid.buffer',
                size: bufferSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            });
            this._uploadInstructionGrid();
        }

        if (this._target.persistentTexture) this._target.persistentTexture.destroy();
        this._target.persistentTexture = device.createTexture({
            label: '_target.persistentTexture',
            size: [this._target.canvas.width, this._target.canvas.height],
            format: this._target.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        });

        this._target.persistentTextureView = this._target.persistentTexture.createView({ dimension: '2d' });
        this._target.descriptor.colorAttachments[0].view = this._target.persistentTextureView;
        this._target.descriptor.colorAttachments[0].loadOp = 'clear';

        this._updateParamsBuffer();
        this._rebindRenderBindGroup();
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

    _uploadInstructionGrid() {
        if (!this._instructionGrid.dirty || !this._instructionGrid.buffer) return;
        const data = this._instructionGrid.data;
        const device = this._webGPU.device;

        const uintsPerCell = 4;
        const bytesPerCell = 16;
        const totalCells = this._target.cols * this._target.rows;

        const minCell = Math.max(0, this._instructionGrid.minDirtyIdx);
        const maxCell = Math.min(totalCells - 1, this._instructionGrid.maxDirtyIdx);

        if (minCell <= maxCell) {
            const startUintIdx = minCell * uintsPerCell;
            const endUintIdx = (maxCell + 1) * uintsPerCell;
            const byteOffset = minCell * bytesPerCell;
            const dirtySubarray = data.subarray(startUintIdx, endUintIdx);

            device.queue.writeBuffer(this._instructionGrid.buffer, byteOffset, dirtySubarray);
        }

        this._instructionGrid.dirty = false;
        this._instructionGrid.minDirtyIdx = totalCells;
        this._instructionGrid.maxDirtyIdx = -1;
    }

    _setupGPU_BuffersAndTextures(glyphBitmap) {
        const device = this._webGPU.device;

        if (!this._webGPU.paramsBuffer) {
            this._webGPU.paramsBuffer = device.createBuffer({
                label: '_paramsBuffer',
                size: 32,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
        }
        this._updateParamsBuffer();

        if (this._mode === 'canvas') {
            if (this._source.texture) this._source.texture.destroy();
            this._source.texture = device.createTexture({
                label: '_source.texture',
                size: [this._target.cols, this._target.rows],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
            });

            const charMapLength = (this._palettes.charMap ? this._palettes.charMap.length : GlyphWebGPU.ARR_LEN) * 4;
            const colMapFGLength = (this._palettes.colourMapFG ? this._palettes.colourMapFG.length : GlyphWebGPU.ARR_LEN * 4) * 4;
            const colMapBGLength = (this._palettes.colourMapBG ? this._palettes.colourMapBG.length : GlyphWebGPU.ARR_LEN * 4) * 4;

            if (this._palettes.charBuffer) this._palettes.charBuffer.destroy();
            if (this._palettes.colourBufferFG) this._palettes.colourBufferFG.destroy();
            if (this._palettes.colourBufferBG) this._palettes.colourBufferBG.destroy();

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
        } else if (this._mode === 'instructions') {
            if (this._instructionGrid.buffer) this._instructionGrid.buffer.destroy();
            const bufferSize = this._instructionGrid.data.byteLength;
            this._instructionGrid.buffer = device.createBuffer({
                label: '_instructionGrid.buffer',
                size: bufferSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            });

            this._uploadInstructionGrid();
        }

        if (this._target.persistentTexture) this._target.persistentTexture.destroy();
        this._target.persistentTexture = device.createTexture({
            label: '_target.persistentTexture',
            size: [this._target.canvas.width, this._target.canvas.height],
            format: this._target.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        });

        this._target.persistentTextureView = this._target.persistentTexture.createView({ dimension: '2d' });

        this._target.descriptor = {
            colorAttachments: [{
                view: this._target.persistentTextureView,
                clearValue: [0, 0, 0, 1],
                loadOp: 'clear',
                storeOp: 'store'
            }]
        };

        if (!this._glyph.texture) {
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
    }

    _rebindRenderBindGroup() {
        const device = this._webGPU.device;
        if (!device || !this._webGPU.render.bindGroupLayout) return;

        let entries = [];
        if (this._mode === 'canvas') {
            entries = [
                { binding: 0, resource: { buffer: this._webGPU.paramsBuffer } },
                { binding: 1, resource: this._source.texture.createView({ dimension: '2d' }) },
                { binding: 2, resource: { buffer: this._palettes.charBuffer } },
                { binding: 3, resource: { buffer: this._palettes.colourBufferFG } },
                { binding: 4, resource: { buffer: this._palettes.colourBufferBG } },
                { binding: 5, resource: this._glyph.texture.createView({ dimension: '2d' }) }
            ];
        } else if (this._mode === 'instructions') {
            entries = [
                { binding: 0, resource: { buffer: this._webGPU.paramsBuffer } },
                { binding: 1, resource: { buffer: this._instructionGrid.buffer } },
                { binding: 2, resource: this._glyph.texture.createView({ dimension: '2d' }) }
            ];
        }

        this._webGPU.render.bindGroup = device.createBindGroup({
            label: '_renderBindGroup',
            layout: this._webGPU.render.bindGroupLayout,
            entries: entries
        });
    }

    _setupGPU_RenderModule() {
        const device = this._webGPU.device;

        let shaderCode = '';
        let bindGroupLayoutEntries = [];

        if (this._mode === 'canvas') {
            shaderCode = `
                struct Params {
                    glyphWidth: u32,
                    glyphHeight: u32,
                    glyphCols: u32,
                    maxCols: u32,
                    maxRows: u32,
                    decayFactor: f32,
                    useCanvasColor: u32,
                    _pad: u32,
                };

                @group(0) @binding(0) var<uniform> params: Params;
                @group(0) @binding(1) var inputCanvas: texture_2d<f32>;
                @group(0) @binding(2) var<storage, read> charMap: array<f32>;
                @group(0) @binding(3) var<storage, read> colourMapFG: array<vec4f>;
                @group(0) @binding(4) var<storage, read> colourMapBG: array<vec4f>;
                @group(0) @binding(5) var inputAtlas: texture_2d<f32>;

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

                    let cellX = pixelX / params.glyphWidth;
                    let cellY = pixelY / params.glyphHeight;

                    if (cellX >= params.maxCols || cellY >= params.maxRows) {
                        return vec4f(0.0, 0.0, 0.0, 1.0);
                    }

                    let colour = textureLoad(inputCanvas, vec2u(cellX, cellY), 0u);
                    let luma = clamp(dot(colour.rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
                    let brightness = u32(luma * 255.0);

                    let charCode = u32(charMap[brightness]);
                    let fg = select(colourMapFG[brightness].rgb, colour.rgb, params.useCanvasColor == 1u);
                    let bg = colourMapBG[brightness].rgb;

                    let glyphLocalX = pixelX % params.glyphWidth;
                    let glyphLocalY = pixelY % params.glyphHeight;

                    let atlasCellX = charCode % params.glyphCols;
                    let atlasCellY = charCode / params.glyphCols;

                    let atlasPixel = vec2u(
                        atlasCellX * params.glyphWidth + glyphLocalX,
                        atlasCellY * params.glyphHeight + glyphLocalY
                    );

                    let s = textureLoad(inputAtlas, atlasPixel, 0u);
                    let color = mix(bg, fg, s.rgb);
                    let alpha = select(mix(params.decayFactor, 1.0, s.r), 1.0, params.decayFactor <= 0.0);

                    return vec4f(color, alpha);
                }
            `;

            bindGroupLayoutEntries = [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} }
            ];
        } else if (this._mode === 'instructions') {
            shaderCode = `
                struct Params {
                    glyphWidth: u32,
                    glyphHeight: u32,
                    glyphCols: u32,
                    maxCols: u32,
                    maxRows: u32,
                    decayFactor: f32,
                };

                struct Cell {
                    charCode: u32,
                    fgColor: u32,
                    bgColor: u32,
                    _pad: u32,
                };

                @group(0) @binding(0) var<uniform> params: Params;
                @group(0) @binding(1) var<storage, read> gridBuffer: array<Cell>;
                @group(0) @binding(2) var inputAtlas: texture_2d<f32>;

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

                    let cellX = pixelX / params.glyphWidth;
                    let cellY = pixelY / params.glyphHeight;

                    if (cellX >= params.maxCols || cellY >= params.maxRows) {
                        return vec4f(0.0, 0.0, 0.0, 1.0);
                    }

                    let cellIndex = cellY * params.maxCols + cellX;
                    let cell = gridBuffer[cellIndex];

                    let charCode = cell.charCode;
                    let fg = unpack4x8unorm(cell.fgColor).rgb;
                    let bg = unpack4x8unorm(cell.bgColor).rgb;

                    let glyphLocalX = pixelX % params.glyphWidth;
                    let glyphLocalY = pixelY % params.glyphHeight;

                    let atlasCellX = charCode % params.glyphCols;
                    let atlasCellY = charCode / params.glyphCols;

                    let atlasPixel = vec2u(
                        atlasCellX * params.glyphWidth + glyphLocalX,
                        atlasCellY * params.glyphHeight + glyphLocalY
                    );

                    let s = textureLoad(inputAtlas, atlasPixel, 0u);
                    let color = mix(bg, fg, s.rgb);
                    let alpha = select(mix(params.decayFactor, 1.0, s.r), 1.0, params.decayFactor <= 0.0);

                    return vec4f(color, alpha);
                }
            `;

            bindGroupLayoutEntries = [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }
            ];
        }

        const renderModule = device.createShaderModule({
            label: 'renderModule',
            code: shaderCode
        });

        this._webGPU.render.bindGroupLayout = device.createBindGroupLayout({
            label: '_renderBindGroupLayout',
            entries: bindGroupLayoutEntries
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

        this._rebindRenderBindGroup();
    }

    /**
     * Updates one or more cells in Instruction Mode grid staging buffer.
     * Each instruction object can hold: { x, y, charCode, fg, bg, fgColor, bgColor }
     * Updates are cumulative and persist on the GPU across frame draws.
     * @param {Array<object>|object} instructions - Single instruction or array of instruction objects.
     */
    updateGlyphs(instructions) {
        if (this._mode !== 'instructions') {
            console.warn('updateGlyphs() called on GlyphWebGPU engine in canvas mode.');
            return;
        }

        const list = Array.isArray(instructions) ? instructions : [instructions];
        if (list.length === 0) return;

        const data = this._instructionGrid.data;
        const cols = this._target.cols;
        const rows = this._target.rows;
        const uintsPerCell = 4;
        const totalCells = cols * rows;

        let minCell = this._instructionGrid.minDirtyIdx;
        let maxCell = this._instructionGrid.maxDirtyIdx;

        for (let i = 0; i < list.length; i++) {
            const inst = list[i];
            const x = inst.x;
            const y = inst.y;

            if (x < 0 || x >= cols || y < 0 || y >= rows) continue;

            const cellIdx = y * cols + x;
            const uintIdx = cellIdx * uintsPerCell;

            if (inst.charCode !== undefined) {
                data[uintIdx] = typeof inst.charCode === 'string' ? inst.charCode.charCodeAt(0) : inst.charCode;
            }

            const fg = inst.fg ?? inst.fgColor;
            if (fg !== undefined) {
                data[uintIdx + 1] = typeof fg === 'number' ? (fg >>> 0) : _packGlyphColorRGBA8(fg, 0xFFFFFFFF);
            }

            const bg = inst.bg ?? inst.bgColor;
            if (bg !== undefined) {
                data[uintIdx + 2] = typeof bg === 'number' ? (bg >>> 0) : _packGlyphColorRGBA8(bg, 0xFF000000);
            }

            if (cellIdx < minCell) minCell = cellIdx;
            if (cellIdx > maxCell) maxCell = cellIdx;
        }

        this._instructionGrid.dirty = true;
        this._instructionGrid.minDirtyIdx = minCell;
        this._instructionGrid.maxDirtyIdx = maxCell;
    }

    /**
     * Fast direct cell update method without array allocations.
     */
    setCell(x, y, charCode, fg, bg) {
        if (this._mode !== 'instructions') return;
        const cols = this._target.cols;
        const rows = this._target.rows;
        if (x < 0 || x >= cols || y < 0 || y >= rows) return;

        const cellIdx = y * cols + x;
        const uintIdx = cellIdx * 4;
        const data = this._instructionGrid.data;

        if (charCode !== undefined) {
            data[uintIdx] = typeof charCode === 'string' ? charCode.charCodeAt(0) : charCode;
        }
        if (fg !== undefined) {
            data[uintIdx + 1] = typeof fg === 'number' ? (fg >>> 0) : _packGlyphColorRGBA8(fg, 0xFFFFFFFF);
        }
        if (bg !== undefined) {
            data[uintIdx + 2] = typeof bg === 'number' ? (bg >>> 0) : _packGlyphColorRGBA8(bg, 0xFF000000);
        }

        this._instructionGrid.dirty = true;
        if (cellIdx < this._instructionGrid.minDirtyIdx) this._instructionGrid.minDirtyIdx = cellIdx;
        if (cellIdx > this._instructionGrid.maxDirtyIdx) this._instructionGrid.maxDirtyIdx = cellIdx;
    }

    /**
     * Static helper to pre-pack RGB/RGBA colors into uint32 bitmasks for maximum update performance.
     */
    static packColor(r, g, b, a = 1.0) {
        return _packGlyphColorRGBA8([r, g, b, a]);
    }

    /**
     * Clears all cells in Instruction Mode to a given character, foreground, and background color.
     */
    clear(charCode = 32, fg = [1, 1, 1], bg = [0, 0, 0]) {
        if (this._mode !== 'instructions') return;
        const cols = this._target.cols;
        const rows = this._target.rows;
        this.clearRect(0, 0, cols, rows, charCode, fg, bg);
    }

    /**
     * Clears a rectangular region of cells in Instruction Mode.
     */
    clearRect(startX, startY, width, height, charCode = 32, fg = [1, 1, 1], bg = [0, 0, 0]) {
        if (this._mode !== 'instructions') return;

        const cols = this._target.cols;
        const rows = this._target.rows;
        const data = this._instructionGrid.data;
        const uintsPerCell = 4;

        const packedFG = _packGlyphColorRGBA8(fg, 0xFFFFFFFF);
        const packedBG = _packGlyphColorRGBA8(bg, 0xFF000000);
        const codeNum = typeof charCode === 'string' ? charCode.charCodeAt(0) : charCode;

        const endX = Math.min(startX + width, cols);
        const endY = Math.min(startY + height, rows);

        let minCell = cols * rows;
        let maxCell = -1;

        for (let y = Math.max(0, startY); y < endY; y++) {
            for (let x = Math.max(0, startX); x < endX; x++) {
                const cellIdx = y * cols + x;
                const uintIdx = cellIdx * uintsPerCell;
                data[uintIdx] = codeNum;
                data[uintIdx + 1] = packedFG;
                data[uintIdx + 2] = packedBG;

                if (cellIdx < minCell) minCell = cellIdx;
                if (cellIdx > maxCell) maxCell = cellIdx;
            }
        }

        if (maxCell >= minCell) {
            this._instructionGrid.dirty = true;
            if (minCell < this._instructionGrid.minDirtyIdx) this._instructionGrid.minDirtyIdx = minCell;
            if (maxCell > this._instructionGrid.maxDirtyIdx) this._instructionGrid.maxDirtyIdx = maxCell;
        }
    }

    _render() {
        if (this._mode === 'canvas') {
            const copyW = Math.min(this._target.cols, this._source.canvas.width);
            const copyH = Math.min(this._target.rows, this._source.canvas.height);

            if (copyW <= 0 || copyH <= 0) return;

            this._webGPU.device.queue.copyExternalImageToTexture(
                { source: this._source.canvas },
                { texture: this._source.texture },
                [copyW, copyH]
            );
        } else if (this._mode === 'instructions') {
            this._uploadInstructionGrid();
        }

        const encoder = this._webGPU.device.createCommandEncoder();

        const renderPass = encoder.beginRenderPass(this._target.descriptor);
        renderPass.setPipeline(this._webGPU.render.pipeline);
        renderPass.setBindGroup(0, this._webGPU.render.bindGroup);
        renderPass.draw(3, 1);
        renderPass.end();

        if (this._decay > 0.0) {
            this._target.descriptor.colorAttachments[0].loadOp = 'load';
        } else {
            this._target.descriptor.colorAttachments[0].loadOp = 'clear';
        }

        encoder.copyTextureToTexture(
            { texture: this._target.persistentTexture },
            { texture: this._webGPU.context.getCurrentTexture() },
            [this._target.canvas.width, this._target.canvas.height]
        );

        this._webGPU.device.queue.submit([encoder.finish()]);
    }

    /**
     * Renders the current frame.
     * In Instruction Mode, optionally accepts an array of new instructions to apply before rendering.
     * @param {Array<object>|object} [instructions] - Optional instruction array for Instruction Mode.
     */
    draw(instructions) {
        if (!this._webGPU.ready) return;

        if (this._mode === 'instructions' && instructions) {
            this.updateGlyphs(instructions);
        }

        this._render();
    }

    /**
     * Extraction of glyph data for inspection.
     * Supports Canvas Mode (reads pixels from source canvas) and Instruction Mode (reads directly from CPU grid staging buffer).
     * @returns {Promise<{arr: Array<{x: number, y: number, charCode: number, brightness?: number, fg?: Array<number>, bg?: Array<number>}>}>}
     */
    async getGlyphData() {
        const cols = this._target.cols;
        const rows = this._target.rows;
        const arr = [];

        if (this._mode === 'instructions') {
            const data = this._instructionGrid.data;
            const uintsPerCell = 4;
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const idx = (y * cols + x) * uintsPerCell;
                    const charCode = data[idx];
                    if (charCode !== 32) {
                        const fg = _unpackGlyphColorRGBA8(data[idx + 1]);
                        const bg = _unpackGlyphColorRGBA8(data[idx + 2]);
                        arr.push({ x, y, charCode, fg, bg });
                    }
                }
            }
            return { arr };
        }

        // Canvas Mode
        const gl = this._source.canvas ? (this._source.canvas.getContext('webgl2') || this._source.canvas.getContext('webgl')) : null;
        const ctx2d = (!gl && this._source.canvas) ? this._source.canvas.getContext('2d') : null;

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

        for (let y = 0; y < rows; y++) {
            const srcY = gl ? (rows - 1 - y) : y;
            for (let x = 0; x < cols; x++) {
                const idx = (srcY * cols + x) * 4;
                const r = pixels[idx] / 255.0;
                const g = pixels[idx + 1] / 255.0;
                const b = pixels[idx + 2] / 255.0;
                const luma = Math.min(Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 0.0), 1.0);
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
        if (this._webGPU.paramsBuffer) this._webGPU.paramsBuffer.destroy();
        if (this._source.texture) this._source.texture.destroy();
        if (this._target.persistentTexture) this._target.persistentTexture.destroy();
        if (this._glyph.texture) this._glyph.texture.destroy();
        if (this._palettes.charBuffer) this._palettes.charBuffer.destroy();
        if (this._palettes.colourBufferFG) this._palettes.colourBufferFG.destroy();
        if (this._palettes.colourBufferBG) this._palettes.colourBufferBG.destroy();
        if (this._instructionGrid.buffer) this._instructionGrid.buffer.destroy();
        if (this._webGPU.device) this._webGPU.device.destroy();
    }
}