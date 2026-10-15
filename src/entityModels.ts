// Merges the entity models minecraft-model-generator exports per version (custom/entities/<version>/entityModels.json)
// into dist/entityModels.json, in mc-assets' versioned layout: `latest` holds the newest export, and a version key holds,
// for the models, entities and animations that changed in that version, what older versions use.
import fs from 'fs'
import path from 'path/posix'
import { EntityModelsData, EntityModelsIndex, EntityModelsExport } from './consumer/entityModels'

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
    animations: { latest: data.animations }
})

/** Versions oldest first. A value is stored again only where it differs from the next newer export. */
export const mergeEntityExports = (exports: EntityModelsExport[]): EntityModelsData => {
    const merged: EntityModelsData = { versions: exports.map(e => e.version), models: { latest: {} }, entities: { latest: {} }, animations: { latest: {} } }
    const newestFirst = [...exports].reverse()
    for (const kind of ['models', 'entities', 'animations'] as const) {
        // the newer export's value of each key, to store only changes; the key a change goes under is the newer version
        let newer: { version: string, values: Record<string, unknown> } | undefined
        for (const data of newestFirst) {
            const values = data[kind] as Record<string, unknown>
            for (const [key, value] of Object.entries(values)) {
                if (!newer) {
                    (merged[kind].latest as Record<string, unknown>)[key] = value
                    continue
                }
                const newerValue = newer.values[key]
                if (newerValue !== undefined && JSON.stringify(newerValue) === JSON.stringify(value)) continue
                // the value differs from the newer export's (or the key is gone there): older versions read it from here
                merged[kind][newer.version] ??= {}
                ;(merged[kind][newer.version] as Record<string, unknown>)[key] = value
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

if (process.argv[1] && path.basename(process.argv[1].replaceAll('\\', '/')).startsWith('entityModels')) {
    const exports = readEntityExports()
    const merged = mergeEntityExports(exports)
    if (fs.existsSync('./data/data-paths.json')) merged.textureVersions = textureVersions(merged, JSON.parse(fs.readFileSync('./data/data-paths.json', 'utf8')))
    fs.mkdirSync('./dist', { recursive: true })
    fs.writeFileSync('./dist/entityModels.json', JSON.stringify(merged))
    // one file per export, for readers that load only the export a world version uses
    fs.rmSync('./dist/entityModels', { recursive: true, force: true })
    fs.mkdirSync('./dist/entityModels', { recursive: true })
    for (const data of exports) fs.writeFileSync(`./dist/entityModels/${data.version}.json`, JSON.stringify(singleEntityExport(merged, data)))
    const index: EntityModelsIndex = { versions: merged.versions, textureVersions: merged.textureVersions ?? {} }
    fs.writeFileSync('./dist/entityModelsIndex.json', JSON.stringify(index))
    const counts = exports.map(e => `${e.version}: ${Object.keys(e.entities).length} entities, ${Object.keys(e.models).length} models`)
    console.log(`entityModels.json: ${counts.join('; ') || 'no exports'}`)
}
