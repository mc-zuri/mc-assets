// The armor trim textures the game makes at runtime (paletted permutations of the trim patterns, PalettedPermutations in
// the armor trims atlas to 26.2, PalettedTextureManager since), made here from the version's own pattern and palette
// textures, byte for byte: every one is checked against the digest of the image the game made
// (custom/entities/<version>/trimTextures.json, written by minecraft-model-generator).
import crypto from 'crypto'
import fs from 'fs'
import path from 'path/posix'
import zlib from 'zlib'

/** An image as RGBA bytes, row by row. */
export type Rgba = { width: number, height: number, data: Uint8Array }

/** One texture the game draws a trim with: its base texture, key palette and palette (texture paths), size and digest. */
export type TrimTextureSource = {
    base: string
    key?: string
    palette?: string
    width: number
    height: number
    /** SHA-256 of the RGBA bytes */
    sha256: string
}

const crcTable = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xED_B8_83_20 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
    }
    return table
})()

const crc32 = (bytes: Uint8Array) => {
    let c = 0xFF_FF_FF_FF
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xFF]! ^ (c >>> 8)
    return (c ^ 0xFF_FF_FF_FF) >>> 0
}

/**
 * Decodes a PNG to RGBA as the game's image loader (stb_image) does: palette (with transparency), gray, gray and alpha,
 * RGB and RGBA, 8 bits per channel or less (16 keep their high byte). Interlaced images are not supported.
 */
export const decodePng = (file: Uint8Array): Rgba => {
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    let offset = 8
    let width = 0, height = 0, bitDepth = 0, colorType = 0
    let palette: Uint8Array | undefined
    let transparency: Uint8Array | undefined
    const idat: Uint8Array[] = []
    while (offset < file.length) {
        const length = view.getUint32(offset)
        const type = String.fromCharCode(...file.subarray(offset + 4, offset + 8))
        const body = file.subarray(offset + 8, offset + 8 + length)
        if (type === 'IHDR') {
            width = view.getUint32(offset + 8)
            height = view.getUint32(offset + 12)
            bitDepth = body[8]!
            colorType = body[9]!
            if (body[12]) throw new Error('interlaced PNGs are not supported')
        } else if (type === 'PLTE') palette = body
        else if (type === 'tRNS') transparency = body
        else if (type === 'IDAT') idat.push(body)
        else if (type === 'IEND') break
        offset += 12 + length
    }
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
    if (!channels) throw new Error(`PNG color type ${colorType}`)
    const bitsPerPixel = channels * bitDepth
    const stride = Math.ceil(width * bitsPerPixel / 8)
    const bpp = Math.max(1, bitsPerPixel >> 3)
    const raw = zlib.inflateSync(Buffer.concat(idat))
    const rows = new Uint8Array(stride * height)
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
        const out = rows.subarray(y * stride, (y + 1) * stride)
        const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : undefined
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[i - bpp]! : 0
            const b = prev ? prev[i]! : 0
            const c = prev && i >= bpp ? prev[i - bpp]! : 0
            let value = line[i]!
            if (filter === 1) value += a
            else if (filter === 2) value += b
            else if (filter === 3) value += (a + b) >> 1
            else if (filter === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
                value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
            }
            out[i] = value & 0xFF
        }
    }
    const sample = (y: number, index: number) => {
        // the index-th sample of the row, scaled to 8 bits as stb_image does (low bit depths spread, 16 bits: high byte)
        const row = y * stride
        if (bitDepth === 8) return rows[row + index]!
        if (bitDepth === 16) return rows[row + index * 2]!
        const perByte = 8 / bitDepth
        const byte = rows[row + Math.floor(index / perByte)]!
        const shift = 8 - bitDepth * (index % perByte + 1)
        const value = (byte >> shift) & ((1 << bitDepth) - 1)
        return colorType === 3 ? value : value * (0xFF / ((1 << bitDepth) - 1))
    }
    const data = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4
            if (colorType === 3) {
                const index = sample(y, x)
                data[o] = palette![index * 3]!
                data[o + 1] = palette![index * 3 + 1]!
                data[o + 2] = palette![index * 3 + 2]!
                data[o + 3] = transparency && index < transparency.length ? transparency[index]! : 0xFF
            } else if (colorType === 0 || colorType === 4) {
                const gray = sample(y, x * channels)
                data[o] = data[o + 1] = data[o + 2] = gray
                data[o + 3] = colorType === 4 ? sample(y, x * channels + 1) : transparency && bitDepth === 8 && gray === transparency[1] ? 0 : 0xFF
            } else {
                data[o] = sample(y, x * channels)
                data[o + 1] = sample(y, x * channels + 1)
                data[o + 2] = sample(y, x * channels + 2)
                data[o + 3] = colorType === 6 ? sample(y, x * channels + 3) : 0xFF
                if (colorType === 2 && transparency && data[o] === transparency[1] && data[o + 1] === transparency[3] && data[o + 2] === transparency[5]) data[o + 3] = 0
            }
        }
    }
    return { width, height, data }
}

const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, body.length)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(body, 8)
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
    return out
}

/** An RGBA PNG of the image. */
export const encodePng = (image: Rgba) => {
    const header = new Uint8Array(13)
    const view = new DataView(header.buffer)
    view.setUint32(0, image.width)
    view.setUint32(4, image.height)
    header[8] = 8
    header[9] = 6
    const raw = new Uint8Array((image.width * 4 + 1) * image.height)
    for (let y = 0; y < image.height; y++) raw.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * (image.width * 4 + 1) + 1)
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', new Uint8Array())
    ])
}

export const rgbaSha256 = (image: Rgba) => crypto.createHash('sha256').update(image.data).digest('hex')

/**
 * The game's palette mapping (PalettedPermutations.createPaletteMapping, PaletteMapping since 26.3): a pixel whose
 * color (alpha aside) is the key palette's i-th takes the palette's i-th color, with alpha the product of both alphas
 * (integer division); colors of no key keep theirs, fully transparent pixels stay as they are.
 */
export const permute = (base: Rgba, key: Rgba, palette: Rgba): Rgba => {
    const keys = key.width * key.height
    if (palette.width * palette.height !== keys) throw new Error(`palette has ${palette.width * palette.height} colors, the key ${keys}`)
    const map = new Map<number, number>()
    for (let i = 0; i < keys; i++) {
        if (key.data[i * 4 + 3] === 0) continue
        const rgb = key.data[i * 4]! << 16 | key.data[i * 4 + 1]! << 8 | key.data[i * 4 + 2]!
        map.set(rgb, (palette.data[i * 4]! << 24 | palette.data[i * 4 + 1]! << 16 | palette.data[i * 4 + 2]! << 8 | palette.data[i * 4 + 3]!) >>> 0)
    }
    const data = new Uint8Array(base.data)
    for (let o = 0; o < data.length; o += 4) {
        const alpha = data[o + 3]!
        if (alpha === 0) continue
        const rgb = data[o]! << 16 | data[o + 1]! << 8 | data[o + 2]!
        const target = map.get(rgb)
        if (target === undefined) continue // opaque(rgb): the same color, alpha * 255 / 255
        data[o] = target >>> 24
        data[o + 1] = (target >>> 16) & 0xFF
        data[o + 2] = (target >>> 8) & 0xFF
        data[o + 3] = Math.floor(alpha * (target & 0xFF) / 255)
    }
    return { width: base.width, height: base.height, data }
}

const semverNumber = (version: string) => {
    const [x, y = '0', z = '0'] = version.split('.')
    return +`${x!.padStart(2, '0')}${y.padStart(2, '0')}${z.padStart(2, '0')}`
}

/**
 * Where a version's copy of a texture is in data/ (data-paths.json): the oldest version key above the version holding
 * one (what versions before it use), else latest.
 */
export const versionTexture = (dataPaths: Record<string, Record<string, Record<string, string>>>, version: string, texture: string) => {
    const file = `${texture.replace(/^minecraft:/, '')}.png`
    const keys = Object.keys(dataPaths).filter(key => key !== 'latest' && /^\d+(\.\d+)*$/.test(key) && semverNumber(key) > semverNumber(version) && dataPaths[key]!['textures/']?.[file])
    keys.sort((a, b) => semverNumber(a) - semverNumber(b))
    const key = keys[0] ?? 'latest'
    return dataPaths[key]!['textures/']?.[file]
}

/** Makes every trim texture of an export from the version's textures; throws when one is not the game's image. */
export const makeTrimTextures = (version: string, sources: Record<string, TrimTextureSource>, dataPaths: Record<string, Record<string, Record<string, string>>>, dataDir = './data') => {
    const images = new Map<string, Rgba>()
    const load = (texture: string) => {
        const file = versionTexture(dataPaths, version, texture)
        if (!file) throw new Error(`${version}: no texture ${texture} in data-paths`)
        let image = images.get(file)
        if (!image) images.set(file, image = decodePng(fs.readFileSync(path.join(dataDir, file))))
        return image
    }
    const made = new Map<string, Rgba>()
    const wrong: string[] = []
    for (const [name, source] of Object.entries(sources)) {
        const base = load(source.base)
        const image = source.key && source.palette ? permute(base, load(source.key), load(source.palette)) : { ...base, data: new Uint8Array(base.data) }
        if (image.width !== source.width || image.height !== source.height || rgbaSha256(image) !== source.sha256) {
            wrong.push(name)
            continue
        }
        made.set(name, image)
    }
    if (wrong.length) throw new Error(`${version}: ${wrong.length} trim textures are not the game's: ${wrong.slice(0, 5).join(', ')}`)
    return made
}
