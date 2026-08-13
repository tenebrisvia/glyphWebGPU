"use strict";

// Mulberry32 32-bit PRNG (Fast, deterministic pseudo-random generator with seed 100)
function mulberry32(a) {
    return function () {
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const prng = mulberry32(100);

// Peaked / center-weighted random distribution offset generator
function gteat(min, max) {
    const x = 0.5 * (0.5 + (0.5 - prng()) * prng() + prng());
    return min + x * (max - min);
}

// Application Configuration & State Constants
const p5Canvas = document.getElementById('p5Canvas');
const asciiCanvas = document.getElementById('asciiCanvas');
const ZOOM = 2.0; // 2x zoom -> 8x8 glyph renders as 16x16
const settings = {
    stroke_width: 32,
    noise_incr: 0.001,
    rotation_strength: 0.4,
    animate: true,
    noiseXOffset: 0,
    noiseYOffset: 1000,
    blob_radius: 280,
    blob_noise_scale: 1.6,
    blob_amplitude: 40,
    fileWidth: 128,
    fileHeight: 128,
    charWidth: 8,
    charHeight: 8
};
const cellWidth = settings.charWidth * ZOOM;
const cellHeight = settings.charHeight * ZOOM;

// High-DPI / Retina Screen Scaling (capped at 2x)
const dpr = Math.min(window.devicePixelRatio || 1, 2);

// ASCII Grid Dimensions (Columns & Rows)
let _dimX = Math.floor(window.innerWidth * dpr / cellWidth);
let _dimY = Math.floor(window.innerHeight * dpr / cellHeight);

asciiCanvas.width = _dimX * settings.charWidth;
asciiCanvas.height = _dimY * settings.charHeight;
asciiCanvas.style.width = `${(_dimX * cellWidth) / dpr}px`;
asciiCanvas.style.height = `${(_dimY * cellHeight) / dpr}px`;

// Color Palettes & Engine Handles
let f_R, f_G, f_B;
let b_R, b_G, b_B;
let glyphWebGPU = null;
let gui = new lil.GUI();
let cam;
let mesh;

// Physics-based Interactive State (Rotation, Translation, Zoom with Damping)
let mouse = {
    damping: 0.94,
    rotate: {
        isDragging: false,
        previous: [0, 0],
        velocity: [0, 0],
        rotation: [0, 0]
    },
    pan: {
        isDragging: false,
        previous: [0, 0],
        velocity: [0, 0],
        translation: [0, 0]
    },
    zoom: {
        velocity: 0,
        scale: 1.4
    }
};
let rx_orig, ry_orig;

let baseSphereNormals = [];

/**
 * Initializes a persistent 3D sphere geometry structure.
 */
function initBlobMesh(detail) {
    mesh = new p5.Geometry();
    mesh.gid = 'blob_mesh'; // Named gid so p5 can cache/evict it by key
    baseSphereNormals = [];

    for (let i = 0; i <= detail; i++) {
        const lat = map(i, 0, detail, -HALF_PI, HALF_PI);
        const cosLat = cos(lat);
        const sinLat = sin(lat);

        for (let j = 0; j <= detail; j++) {
            const lon = map(j, 0, detail, -PI, PI);
            const cosLon = cos(lon);
            const sinLon = sin(lon);

            const nx = cosLat * cosLon;
            const ny = sinLat;
            const nz = cosLat * sinLon;

            baseSphereNormals.push({ nx, ny, nz });
            mesh.vertices.push(createVector(0, 0, 0));
            mesh.uvs.push([j / detail, i / detail]);
        }
    }

    for (let i = 0; i < detail; i++) {
        for (let j = 0; j < detail; j++) {
            const first = i * (detail + 1) + j;
            const second = first + detail + 1;

            mesh.faces.push([first, second, first + 1]);
            mesh.faces.push([second, second + 1, first + 1]);
        }
    }
}

/**
 * Updates procedural 3D blob vertex displacements in-place and forces p5 WebGL buffer refresh.
 */
function updateBlobMesh() {
    if (!mesh || baseSphereNormals.length === 0) return;

    const radius = settings.blob_radius;
    const amp = settings.blob_amplitude;
    const scale = settings.blob_noise_scale;
    const time = settings.noiseXOffset * 2.0;

    for (let k = 0; k < baseSphereNormals.length; k++) {
        const { nx, ny, nz } = baseSphereNormals[k];
        const n1 = noise(nx * scale + 10.0, ny * scale + time, nz * scale + 20.0);
        const ridged = 1.0 - abs(n1 - 0.5) * 2.0;
        const n2 = noise(nx * scale * 2.5 + 40.0, ny * scale * 2.5 + time * 1.5, nz * scale * 2.5 + 80.0);
        const angle = atan2(ny, nx);
        const flute = sin(angle * 6.0 + time * 0.5) * cos(nz * scale * 1.5);
        const displacement = (ridged * 0.6 + flute * 0.35 + (n2 - 0.5) * 0.45);
        const r = radius + (displacement - 0.4) * amp * 1.6;

        mesh.vertices[k].set(nx * r, ny * r, nz * r);
    }

    mesh.computeNormals();

    // Evict the cached GPU VBO so model() re-uploads fresh vertex data next frame
    if (_renderer && _renderer.retainedMode && _renderer.retainedMode.geometry[mesh.gid]) {
        _renderer._freeBuffers(mesh.gid);
    }
}

/**
 * p5.js Setup Callback: Initializes 3D canvas, loads assets, builds palettes, and boots WebGPU.
 */
async function setup() {
    // Force 1:1 pixel density on 3D source canvas (1 source pixel per ASCII cell)
    pixelDensity(1);
    createCanvas(_dimX, _dimY, WEBGL, p5Canvas);
    angleMode(RADIANS);

    // ASCII Character & Palette Initialization
    const chars = Util.spreadArray([32, 32, 32, 144, 144, 209, 209, 204, 204, 205, 205], GlyphWebGPU.ARR_LEN);
    const padding = Util.spreadArray([0], GlyphWebGPU.ARR_LEN);

    // Center-weighted color variations for foreground shading
    f_R = Util.spreadArray([0, 0x04, 0x04, 0x04, 0x04, 0xf5, 0xf5, 0xf5, 0xf5, 0xee, 0xee], GlyphWebGPU.ARR_LEN, () => ~~gteat(-3, 3));
    f_G = Util.spreadArray([0, 0x31, 0x31, 0x31, 0x31, 0x6f, 0x6f, 0x6f, 0x6f, 0xaf, 0xaf], GlyphWebGPU.ARR_LEN, () => ~~gteat(-3, 3));
    f_B = Util.spreadArray([0, 0xc2, 0xc2, 0xc2, 0xc2, 0x19, 0x19, 0x19, 0x19, 0x17, 0x17], GlyphWebGPU.ARR_LEN, () => ~~gteat(-3, 3));
    b_R = Util.spreadArray([0], GlyphWebGPU.ARR_LEN);
    b_G = Util.spreadArray([0], GlyphWebGPU.ARR_LEN);
    b_B = Util.spreadArray([0], GlyphWebGPU.ARR_LEN);

    // Boot WebGPU Engine Asynchronously
    (async () => {
        try {
            glyphWebGPU = new GlyphWebGPU(p5Canvas, asciiCanvas, _dimX, _dimY, 0.08);
            glyphWebGPU._instructions.charMap = chars;
            glyphWebGPU._instructions.colourMapFG = Util.interleaveArrays(f_R, f_G, f_B, padding);
            glyphWebGPU._instructions.colourMapBG = Util.interleaveArrays(b_R, b_G, b_B, padding);
            await glyphWebGPU.loadGlyphsURL("./Amstrad_CPC_Full_AMSDOS_Character_Set.png", settings.fileWidth, settings.fileHeight, settings.charWidth, settings.charHeight);
        }
        catch (ex) {
            document.body.insertBefore(document.createTextNode(ex), document.body.firstChild);
        }
    })();

    // Construct Procedural 3D Noisy Blob Geometry
    noStroke();
    initBlobMesh(48);
    updateBlobMesh();
    cam = createCamera();
    cam.setPosition(0, 0, 1000);
    cam.lookAt(0, 0, 0);

    // Setup User Interface Controls (lil-gui)
    const functions = {
        createSVG: async function () {
            const result = await glyphWebGPU.getGlyphData();
            createSVG(result.arr, _dimX, _dimY, 'svgContainer');
            downloadSVG();
        }
    };
    gui.add(settings, 'blob_radius', 100, 500, 10).name('blob radius').onChange(updateBlobMesh);
    gui.add(settings, 'blob_amplitude', 0, 200, 5).name('noise amplitude').onChange(updateBlobMesh);
    gui.add(settings, 'blob_noise_scale', 0.2, 5.0, 0.1).name('noise scale').onChange(updateBlobMesh);
    gui.add(settings, 'noise_incr', 0.0, 0.001, 0.0001).name('morph speed');
    gui.add(settings, 'animate').listen().onChange((newVal) => { settings.animate = newVal; });
    gui.add(settings, 'stroke_width', 1, 64, 1).name('svg line width');
    gui.add(functions, 'createSVG').name('download svg');

    gui.hide();

    // Toggle GUI with 'C' Key
    document.addEventListener('keydown', function (event) {
        if (event.key === 'c' || event.key === 'C')
            gui.show(gui._hidden);
    });

    asciiCanvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    // Mouse Interaction Handlers (Left Click = Rotate, Right Click = Pan)
    asciiCanvas.addEventListener('mousedown', (event) => {
        let adjust = null;
        if (event.button === 0)
            adjust = mouse.rotate;
        else if (event.button === 2)
            adjust = mouse.pan;

        if (adjust != null) {
            adjust.isDragging = true;
            adjust.previous = [event.clientX, event.clientY];
            adjust.velocity = [0, 0];
        }
        return false;
    });

    asciiCanvas.addEventListener('mousemove', (event) => {
        if (mouse.rotate.isDragging && (event.buttons & 1)) {
            const deltaX = event.clientX - mouse.rotate.previous[0];
            const deltaY = event.clientY - mouse.rotate.previous[1];

            mouse.rotate.rotation[0] += deltaX * 0.005;
            mouse.rotate.rotation[1] += deltaY * 0.005;
            mouse.rotate.velocity = [deltaX * 0.005, deltaY * 0.005];
            mouse.rotate.previous = [event.clientX, event.clientY];
        }
        else if (mouse.pan.isDragging && (event.buttons & 2)) {
            const deltaX = event.clientX - mouse.pan.previous[0];
            const deltaY = event.clientY - mouse.pan.previous[1];

            mouse.pan.translation[0] += deltaX * 0.5;
            mouse.pan.translation[1] += deltaY * 0.5;
            mouse.pan.velocity = [deltaX * 0.5, deltaY * 0.5];
            mouse.pan.previous = [event.clientX, event.clientY];
        }

        return false;
    });

    asciiCanvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        mouse.zoom.velocity += (event.deltaY < 0) ? 0.015 : -0.015;
    });

    asciiCanvas.addEventListener('mouseup', () => {
        mouse.rotate.isDragging = mouse.pan.isDragging = false;
    });

    asciiCanvas.addEventListener('mouseout', () => {
        mouse.rotate.isDragging = mouse.pan.isDragging = false;
    });

    // Mobile Touch Gesture Support (1-finger rotate, 2-finger pan & pinch-zoom)
    const touchState = {
        previousDist: 0,
        previousMid: [0, 0]
    };

    asciiCanvas.addEventListener('touchstart', (event) => {
        event.preventDefault();
        if (event.touches.length === 1) {
            mouse.rotate.isDragging = true;
            mouse.pan.isDragging = false;
            mouse.rotate.previous = [event.touches[0].clientX, event.touches[0].clientY];
            mouse.rotate.velocity = [0, 0];
        } else if (event.touches.length === 2) {
            mouse.rotate.isDragging = false;
            mouse.pan.isDragging = true;

            const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
            const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
            const dist = Math.hypot(
                event.touches[1].clientX - event.touches[0].clientX,
                event.touches[1].clientY - event.touches[0].clientY
            );

            touchState.previousMid = [midX, midY];
            touchState.previousDist = dist;
            mouse.pan.previous = [midX, midY];
            mouse.pan.velocity = [0, 0];
        }
    }, { passive: false });

    asciiCanvas.addEventListener('touchmove', (event) => {
        event.preventDefault();
        if (event.touches.length === 1 && mouse.rotate.isDragging) {
            const touch = event.touches[0];
            const deltaX = touch.clientX - mouse.rotate.previous[0];
            const deltaY = touch.clientY - mouse.rotate.previous[1];

            mouse.rotate.rotation[0] += deltaX * 0.005;
            mouse.rotate.rotation[1] += deltaY * 0.005;
            mouse.rotate.velocity = [deltaX * 0.005, deltaY * 0.005];
            mouse.rotate.previous = [touch.clientX, touch.clientY];
        } else if (event.touches.length === 2 && mouse.pan.isDragging) {
            const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
            const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
            const dist = Math.hypot(
                event.touches[1].clientX - event.touches[0].clientX,
                event.touches[1].clientY - event.touches[0].clientY
            );

            // 2-finger pan
            const deltaMidX = midX - touchState.previousMid[0];
            const deltaMidY = midY - touchState.previousMid[1];

            mouse.pan.translation[0] += deltaMidX * 0.5;
            mouse.pan.translation[1] += deltaMidY * 0.5;
            mouse.pan.velocity = [deltaMidX * 0.5, deltaMidY * 0.5];

            // 2-finger pinch zoom
            const deltaDist = dist - touchState.previousDist;
            mouse.zoom.velocity += deltaDist * 0.001;

            touchState.previousMid = [midX, midY];
            touchState.previousDist = dist;
        }
    }, { passive: false });

    asciiCanvas.addEventListener('touchend', (event) => {
        if (event.touches.length === 0) {
            mouse.rotate.isDragging = false;
            mouse.pan.isDragging = false;
        } else if (event.touches.length === 1) {
            mouse.pan.isDragging = false;
            mouse.rotate.isDragging = true;
            mouse.rotate.previous = [event.touches[0].clientX, event.touches[0].clientY];
            mouse.rotate.velocity = [0, 0];
        }
    });

    asciiCanvas.addEventListener('touchcancel', () => {
        mouse.rotate.isDragging = false;
        mouse.pan.isDragging = false;
    });

    rx_orig = noise(settings.noiseXOffset) * TWO_PI * settings.rotation_strength;
    ry_orig = noise(settings.noiseYOffset) * TWO_PI * settings.rotation_strength;
}

/**
 * p5.js Frame Render Loop: Updates 3D model transforms, renders source scene, and invokes WebGPU.
 */
function draw() {
    // 1. Physical Damping & Inertia Integrators
    mouse.zoom.scale = constrain(mouse.zoom.scale + mouse.zoom.velocity, 0.1, 3.0);
    mouse.zoom.velocity *= mouse.damping;
    if (abs(mouse.zoom.velocity) < 0.001)
        mouse.zoom.velocity = 0;

    if (!mouse.rotate.isDragging) {
        mouse.rotate.rotation[0] += mouse.rotate.velocity[0];
        mouse.rotate.rotation[1] += mouse.rotate.velocity[1];
        mouse.rotate.velocity[0] *= mouse.damping;
        mouse.rotate.velocity[1] *= mouse.damping;
        if (abs(mouse.rotate.velocity[0]) < 0.001) mouse.rotate.velocity[0] = 0;
        if (abs(mouse.rotate.velocity[1]) < 0.001) mouse.rotate.velocity[1] = 0;
    }

    if (!mouse.pan.isDragging) {
        mouse.pan.translation[0] += mouse.pan.velocity[0];
        mouse.pan.translation[1] += mouse.pan.velocity[1];
        mouse.pan.velocity[0] *= mouse.damping;
        mouse.pan.velocity[1] *= mouse.damping;
        if (abs(mouse.pan.velocity[0]) < 0.1) mouse.pan.velocity[0] = 0;
        if (abs(mouse.pan.velocity[1]) < 0.1) mouse.pan.velocity[1] = 0;
    }

    if (settings.animate) {
        settings.noiseXOffset += settings.noise_incr;
        settings.noiseYOffset += settings.noise_incr;
        updateBlobMesh();
    }

    // 2. Clear & Render 3D Offscreen Scene
    background(0);
    ambientLight(40);
    pointLight(130, 130, 130, 300, -300, 1200);
    pointLight(40, 40, 40, -400, 400, 600);
    specularMaterial(60, 60, 60);
    shininess(10);

    let rx = (noise(settings.noiseXOffset) * TWO_PI * settings.rotation_strength) - rx_orig;
    let ry = (noise(settings.noiseYOffset) * TWO_PI * settings.rotation_strength) - ry_orig;

    // 3. Native p5.js WebGL Matrix Transforms
    push();
    translate(mouse.pan.translation[0], mouse.pan.translation[1], 0);
    rotateY(-(PI - mouse.rotate.rotation[0] + ry));
    rotateX(-(PI - mouse.rotate.rotation[1] + rx));
    scale(mouse.zoom.scale);
    model(mesh);
    pop();

    // 4. WebGPU ASCII Presentation Pass
    if (glyphWebGPU) {
        glyphWebGPU.draw();
    }
}

/**
 * Resizes 3D canvas and WebGPU pipeline dynamically on window resize / orientation change.
 */
function windowResized() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cellWidth = settings.charWidth * ZOOM;
    const cellHeight = settings.charHeight * ZOOM;

    _dimX = Math.floor(window.innerWidth * dpr / cellWidth);
    _dimY = Math.floor(window.innerHeight * dpr / cellHeight);

    asciiCanvas.width = _dimX * settings.charWidth;
    asciiCanvas.height = _dimY * settings.charHeight;
    asciiCanvas.style.width = `${(_dimX * cellWidth) / dpr}px`;
    asciiCanvas.style.height = `${(_dimY * cellHeight) / dpr}px`;

    resizeCanvas(_dimX, _dimY);
    if (glyphWebGPU) {
        glyphWebGPU.resize(_dimX, _dimY);
    }
}

function toHex(c) {
    const clamped = Math.max(0, Math.min(255, Math.floor(c)));
    return clamped.toString(16).padStart(2, '0');
}

/**
 * Generates an SVG vector graphic document from extracted cell states.
 */
function createSVG(arr, width, height, div) {
    let w = 0;
    let h = 0;
    const aspect = width / height;

    if ((window.innerWidth / window.innerHeight) < aspect) {
        w = window.innerWidth - 4;
        h = (window.innerWidth / aspect) - 4;
    } else {
        w = (window.innerHeight * aspect) - 4;
        h = window.innerHeight - 4;
    }

    w = ~~w;
    h = ~~h;

    const rgb = [];
    for (let i = 0; i < GlyphWebGPU.ARR_LEN; i++)
        rgb.push(`#${toHex(f_R[i])}${toHex(f_G[i])}${toHex(f_B[i])}`);

    let output = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${w}" height="${h}" viewBox="0 0 ${width} ${height}" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">\r\n`;
    output += `<defs>\r\n`;
    output += `  <style type="text/css">\r\n`;
    output += `    line { stroke-linecap: round; }\r\n`;
    output += `  </style>\r\n`;
    output += `  <symbol id="d" viewBox="0 0 100 100" stroke-width="${settings.stroke_width}" overflow="visible">\r\n`;
    output += `    <line x1="45" y1="50" x2="55" y2="50" />\r\n`;
    output += `  </symbol>\r\n`;
    output += `  <symbol id="v" viewBox="0 0 100 100" stroke-width="${settings.stroke_width}" overflow="visible">\r\n`;
    output += `    <line x1="50" y1="0" x2="50" y2="100" />\r\n`;
    output += `  </symbol>\r\n`;
    output += `  <symbol id="b" viewBox="0 0 100 100" stroke-width="${settings.stroke_width}" overflow="visible">\r\n`;
    output += `    <line x1="0" y1="0" x2="100" y2="100" />\r\n`;
    output += `  </symbol>\r\n`;
    output += `  <symbol id="f" viewBox="0 0 100 100" stroke-width="${settings.stroke_width}" overflow="visible">\r\n`;
    output += `    <line x1="0" y1="100" x2="100" y2="0" />\r\n`;
    output += `  </symbol>\r\n`;
    output += `</defs>\r\n`;
    output += `<rect width="${width}" height="${height}" fill="#000000"></rect>\r\n`;
    output += `<g inkscape:groupmode="layer" id="layer1" inkscape:label="1-layer">\r\n`;

    for (let i = 0; i < arr.length; i++) {
        switch (arr[i].charCode) {
            case 144:
                output += `\t<use href="#d" x="${arr[i].x}" y="${arr[i].y}" width="1" height="1" stroke="${rgb[arr[i].brightness]}" />\r\n`;
                break;
            case 209:
                output += `\t<use href="#v" x="${arr[i].x}" y="${arr[i].y}" width="1" height="1" stroke="${rgb[arr[i].brightness]}" />\r\n`;
                break;
            case 205:
                output += `\t<use href="#b" x="${arr[i].x}" y="${arr[i].y}" width="1" height="1" stroke="${rgb[arr[i].brightness]}" />\r\n`;
                break;
            case 204:
                output += `\t<use href="#f" x="${arr[i].x}" y="${arr[i].y}" width="1" height="1" stroke="${rgb[arr[i].brightness]}" />\r\n`;
                break;
            default:
                break;
        }
    }
    output += `</g>\r\n`;
    output += '</svg>';

    const container = document.getElementById(div);
    container.innerHTML = output;
}

function downloadSVG() {
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const filename = `${year}${month}${day} ${hours}-${minutes}-${seconds}.svg`;

    Util.downloadSVG('svg', filename);
}

/**
 * Utility helper functions for array operations and SVG blob downloads.
 */
class Util {
    static downloadSVG(el, fileName) {
        let elem = document.querySelector(el);
        let elemStr = new XMLSerializer().serializeToString(elem);
        let blob = new Blob([elemStr], { type: "image/svg+xml;charset=utf-8" });
        let domurl = self.URL || self.webkitURL || self;
        let a = document.createElement("a");

        a.download = fileName;
        a.href = domurl.createObjectURL(blob);
        a.dataset.downloadurl = ["image/svg+xml;charset=utf-8", a.download, a.href].join(':');
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    }

    static spreadArray(sourceArray, targetLength, func) {
        let targetArray = new Float32Array(targetLength);
        let baseRepeatCount = ~~(targetLength / sourceArray.length);
        let remainder = targetLength % sourceArray.length;
        let idx = 0;

        for (let i = 0; i < sourceArray.length; i++) {
            let currentRepeatCount = baseRepeatCount;
            if (i < remainder)
                currentRepeatCount++;

            for (let j = 0; j < currentRepeatCount; j++) {
                if (func) {
                    let r = i + func();
                    if ((r >= 0) && (r < sourceArray.length))
                        targetArray[idx] = sourceArray[r];
                    else
                        targetArray[idx] = sourceArray[i];
                }
                else
                    targetArray[idx] = sourceArray[i];

                idx++;
            }
        }

        return targetArray;
    }

    static interleaveArrays(...arrs) {
        const numArrays = arrs.length;
        const numElements = arrs[0].length;
        const mergedArray = new Float32Array(numElements * numArrays);

        for (let i = 0; i < numElements; i++) {
            const baseIndex = i * numArrays;

            for (let j = 0; j < numArrays; j++)
                mergedArray[baseIndex + j] = arrs[j][i] / 255.0;
        }

        return mergedArray;
    }
}