// Merges the entity models minecraft-model-generator exports per version (custom/entities/<version>/entityModels.json)
// into dist/entityModels.json, in mc-assets' versioned layout: `latest` holds the newest export, and a version key holds,
// for the models, entities and animations that changed in that version, what older versions use.
import fs from 'fs'
import path from 'path/posix'
import { EntityModelsData, EntityModelsIndex, EntityModelsExport } from './consumer/entityModels'
import { encodePng, makeTrimTextures, TrimTextureSource } from './trimTextures'

const sourceDir = './custom/entities'

const semverToNumber = (version: string) => {
    const [x, y = '0', z = '0'] = version.split('.')
    return +`${x!.padStart(2, '0')}${y.padStart(2, '0')}${z.padStart(2, '0')}`
}

export const readEntityExports = (dir = sourceDir): EntityModelsExport[] => {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
        .filter(version => fs.existsSync(path.join(dir, version, 'entityModels.json')))
        .sort((a, b) => semverToNumber(a) - semverToNumber(b))
        .map(version => {
            const data = JSON.parse(fs.readFileSync(path.join(dir, version, 'entityModels.json'), 'utf8')) as EntityModelsExport
            if (data.version !== version) throw new Error(`${dir}/${version}/entityModels.json says it is ${data.version}`)
            return data
        })
}

/** One export in the merged layout, every value latest: dist/entityModels/<version>.json. */
export const singleEntityExport = (merged: EntityModelsData, data: EntityModelsExport): EntityModelsData => ({
    versions: merged.versions,
    exportVersion: data.version,
    textureVersions: merged.textureVersions,
    models: { latest: data.models },
    entities: { latest: data.entities },
    animations: { latest: data.animations },
    paintings: { latest: data.paintings ? { paintings: data.paintings } : {} },
    trims: { latest: data.trims ? { trims: data.trims } : {} }
})

/** Versions oldest first. A value is stored again only where it differs from the next newer export. */
export const mergeEntityExports = (exports: EntityModelsExport[]): EntityModelsData => {
    const merged: EntityModelsData = { versions: exports.map(e => e.version), models: { latest: {} }, entities: { latest: {} }, animations: { latest: {} }, paintings: { latest: {} }, trims: { latest: {} } }
    const newestFirst = [...exports].reverse()
    for (const kind of ['models', 'entities', 'animations', 'paintings', 'trims'] as const) {
        // the newer export's value of each key, to store only changes; the key a change goes under is the newer version
        let newer: { version: string, values: Record<string, unknown> } | undefined
        for (const data of newestFirst) {
            const values = (kind === 'paintings' ? (data.paintings ? { paintings: data.paintings } : {}) : kind === 'trims' ? (data.trims ? { trims: data.trims } : {}) : data[kind]) as Record<string, unknown>
            for (const [key, value] of Object.entries(values)) {
                if (!newer) {
                    ((merged[kind] as Record<string, Record<string, unknown>>).latest!)[key] = value
                    continue
                }
                const newerValue = newer.values[key]
                if (newerValue !== undefined && JSON.stringify(newerValue) === JSON.stringify(value)) continue
                // the value differs from the newer export's (or the key is gone there): older versions read it from here
                const byVersion = merged[kind] as Record<string, Record<string, unknown>>
                byVersion[newer.version] ??= {}
                byVersion[newer.version]![key] = value
            }
            newer = { version: data.version, values }
        }
    }
    return merged
}

/**
 * For every texture the entity models use, the versions whose other-textures hold an older copy of it, from
 * data-paths.json: a version key holds what versions before it use (dist/other-textures/<version>/<path>.png), the
 * latest one is in dist/other-textures/latest.
 */
export const textureVersions = (merged: EntityModelsData, dataPaths: Record<string, Record<string, Record<string, string>>>) => {
    const used = new Set<string>()
    const collect = (value: unknown) => {
        if (!value || typeof value !== 'object') return
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
            if (key === 'texture' && typeof inner === 'string') used.add(inner.replace(/^minecraft:/, ''))
            else if (key === 'textureLayers' && Array.isArray(inner)) for (const layer of inner) used.add(String(layer).replace(/^minecraft:/, ''))
            else collect(inner)
        }
    }
    collect(merged.entities)
    collect(merged.paintings)
    const versions: Record<string, string[]> = {}
    for (const [version, paths] of Object.entries(dataPaths)) {
        if (version === 'latest') continue
        const textures = paths['textures/'] ?? {}
        for (const texture of used) {
            if (textures[`${texture}.png`]) (versions[texture] ??= []).push(version)
        }
    }
    return versions
}

/** The trim textures each export draws (custom/entities/<version>/trimTextures.json, 1.19.4+), by version. */
export const readTrimTextureSources = (dir = sourceDir): Record<string, Record<string, TrimTextureSource>> => {
    const sources: Record<string, Record<string, TrimTextureSource>> = {}
    if (!fs.existsSync(dir)) return sources
    for (const version of fs.readdirSync(dir)) {
        const file = path.join(dir, version, 'trimTextures.json')
        if (fs.existsSync(file)) sources[version] = JSON.parse(fs.readFileSync(file, 'utf8'))
    }
    return sources
}

/**
 * Makes the trim textures of every export from its version's textures (each checked against the game's image) and writes
 * them where a version's textures are read from: the newest export's to other-textures/latest, an older export's that
 * differ from the next export's to other-textures/<next export>/ (what versions before it use). Returns, per texture path,
 * the folders holding older copies (textureVersions).
 */
export const writeTrimTextures = (versions: string[], sources: Record<string, Record<string, TrimTextureSource>>, dataPaths: Record<string, Record<string, Record<string, string>>>, outDir = './dist/other-textures') => {
    const sorted = [...versions].sort((a, b) => semverToNumber(a) - semverToNumber(b))
    const folders: Record<string, string[]> = {}
    let newer: Record<string, TrimTextureSource> | undefined
    let written = 0
    for (let i = sorted.length - 1; i >= 0; i--) {
        const version = sorted[i]!
        const own = sources[version]
        if (!own) {
            newer = undefined
            continue
        }
        const images = makeTrimTextures(version, own, dataPaths)
        for (const [name, image] of images) {
            const texture = name.replace(/^minecraft:/, '')
            if (newer?.[name]?.sha256 === own[name]!.sha256) continue
            const folder = i === sorted.length - 1 ? 'latest' : sorted[i + 1]!
            const file = path.join(outDir, folder, `${texture}.png`)
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, encodePng(image))
            if (folder !== 'latest') (folders[texture] ??= []).push(folder)
            written++
        }
        newer = own
    }
    for (const list of Object.values(folders)) list.sort((a, b) => semverToNumber(a) - semverToNumber(b))
    return { folders, written }
}

if (process.argv[1] && path.basename(process.argv[1].replaceAll('\\', '/')).startsWith('entityModels')) {
    const exports = readEntityExports()
    const merged = mergeEntityExports(exports)
    if (fs.existsSync('./data/data-paths.json')) {
        const dataPaths = JSON.parse(fs.readFileSync('./data/data-paths.json', 'utf8'))
        merged.textureVersions = textureVersions(merged, dataPaths)
        // the trim textures the game makes at runtime, made the same way and checked against the game's
        const trims = writeTrimTextures(merged.versions, readTrimTextureSources(), dataPaths)
        for (const [texture, folders] of Object.entries(trims.folders)) merged.textureVersions[texture] = folders
        console.log(`trim textures: ${trims.written} written`)
    }
    fs.mkdirSync('./dist', { recursive: true })
    fs.writeFileSync('./dist/entityModels.json', JSON.stringify(merged))
    // one file per export, for readers that load only the export a world version uses
    fs.rmSync('./dist/entityModels', { recursive: true, force: true })
    fs.mkdirSync('./dist/entityModels', { recursive: true })
    for (const data of exports) fs.writeFileSync(`./dist/entityModels/${data.version}.json`, JSON.stringify(singleEntityExport(merged, data)))
    const entityExports: Record<string, string[]> = {}
    for (const data of exports) for (const name of Object.keys(data.entities)) (entityExports[name] ??= []).push(data.version)
    const index: EntityModelsIndex = { versions: merged.versions, textureVersions: merged.textureVersions ?? {}, entityExports }
    fs.writeFileSync('./dist/entityModelsIndex.json', JSON.stringify(index))
    const counts = exports.map(e => `${e.version}: ${Object.keys(e.entities).length} entities, ${Object.keys(e.models).length} models`)
    console.log(`entityModels.json: ${counts.join('; ') || 'no exports'}`)
}
