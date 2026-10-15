import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path/posix'

import { composeEntityLook, entityModelsExportFor, entityTextureFolder, EntityDefinition, EntityModelsData, EntityModelsExport, EntityModelsIndex, EntityModelsStore } from './consumer/entityModels'
import { mergeEntityExports, readEntityExports } from './entityModels'

const data = JSON.parse(fs.readFileSync('./dist/entityModels.json', 'utf8')) as EntityModelsData
const store = new EntityModelsStore(data)
const latest = data.versions[data.versions.length - 1]!

const exports = readEntityExports()

/** minecraft:entity/zombie/zombie -> dist/other-textures/<the version's folder>/entity/zombie/zombie.png */
const texturePath = (texture: string, version: string) =>
    path.join('./dist/other-textures', entityTextureFolder(data, texture, version), `${texture.replace(/^minecraft:/, '')}.png`)

describe('entity models', () => {
    test('every export is merged', () => {
        expect(data.versions).toEqual(readEntityExports().map(e => e.version))
        expect(data.versions).toContain('26.3')
    })

    for (const version of data.versions) {
        test(`${version}: every model entry names an exported model and a texture that exists`, () => {
            const missing: string[] = []
            // the names this version's own export has (1.8 names entities PigZombie: pig_zombie)
            for (const name of Object.keys(exports.find(e => e.version === version)!.entities)) {
                const entity = store.getEntity(version, name)!
                for (const state of entity.states) {
                    const entries = (state.look ?? state.patch ?? {}) as Record<string, Record<string, unknown> | null>
                    for (const [key, entry] of Object.entries(entries)) {
                        if (!entry) continue
                        if (entry.model && !store.getModel(version, entry.model as string)) missing.push(`${name}[${state.name}] ${key}: model ${entry.model}`)
                        const texture = entry.texture as string | undefined
                        // painting and other atlases are drawn by the renderer from their sprites
                        if (texture && !texture.includes(':atlas/') && !fs.existsSync(texturePath(texture, version))) missing.push(`${name}[${state.name}] ${key}: texture ${texture}`)
                    }
                }
            }
            expect(missing).toEqual([])
        })
    }

    test('states are a default look and patches with conditions', () => {
        for (const [name, entity] of Object.entries(data.entities.latest!)) {
            if (!entity.states.length) continue
            expect(entity.states[0]!.look, name).toBeTruthy()
            expect(entity.states[0]!.when, name).toEqual([])
            for (const state of entity.states.slice(1)) {
                expect(state.patch, `${name}[${state.name}]`).toBeTruthy()
                expect(state.when.length, `${name}[${state.name}]`).toBeGreaterThan(0)
            }
        }
    })

    test('GL-era versions read their own export, under the names they had', () => {
        for (const [version, names] of [
            ['1.8.8', ['pig_zombie', 'entity_horse', 'villager_golem', 'ozelot', 'snow_man', 'wither_boss', 'mushroom_cow']],
            ['1.9.4', ['shulker', 'entity_horse']],
            ['1.10.2', ['polar_bear']],
            ['1.11.2', ['llama', 'evocation_illager', 'vex', 'zombie_villager', 'donkey']],
            ['1.12.2', ['parrot', 'illusion_illager']],
            ['1.13.2', ['drowned', 'dolphin', 'phantom', 'turtle', 'tropical_fish', 'cod']],
            ['1.14.4', ['fox', 'panda', 'ravager', 'pillager', 'wandering_trader', 'cat']]
        ] as const) {
            for (const name of names) {
                const look = composeEntityLook(store.getEntity(version, name)!)
                expect(look.some(({ entry }) => entry.type === 'model'), `${version} ${name}`).toBe(true)
            }
        }
        // a 1.8 zombie is drawn with the 1.8 model (no villager zombie arms), a 1.14 one with its own
        expect(store.getEntity('1.8.8', 'zombie')).not.toEqual(store.getEntity('1.14.4', 'zombie'))
    })

    test('GL-era looks: horse coat color and markings are bytes of one int', () => {
        const horse = store.getEntity('1.12.2', 'horse')!
        const states = horse.states.filter(s => s.name === 'color=3' || s.name === 'markings=2')
        // the bits the values written change: colors 0 to 6, markings 0 to 4 in the second byte
        expect(states.map(s => s.when.map(c => ('mask' in c ? c.mask : undefined)))).toEqual([[7], [0x700]])
        const layers = (look: ReturnType<typeof composeEntityLook>) => (look[0]!.entry as { textureLayers?: string[] }).textureLayers
        const index = (states[0]!.when[0] as { index: number }).index
        expect(layers(composeEntityLook(horse, { metadata: { [index]: 3 | (2 << 8) } }))).toEqual([
            'minecraft:entity/horse/horse_brown',
            'minecraft:entity/horse/horse_markings_whitefield'
        ])
    })

    test('the new mobs have models', () => {
        for (const name of ['happy_ghast', 'copper_golem', 'nautilus', 'zombie_nautilus', 'camel_husk', 'parched', 'sulfur_cube', 'armadillo', 'bogged', 'breeze', 'creaking', 'end_crystal']) {
            const look = composeEntityLook(store.getEntity(latest, name)!)
            expect(look.some(({ entry }) => entry.type === 'model'), name).toBe(true)
        }
    })

    test('looks follow the synched data: a tame ashen wolf with a blue collar', () => {
        const wolf = store.getEntity('26.3', 'wolf')!
        const textures = (metadata: Record<number, unknown>) => composeEntityLook(wolf, { metadata }).map(({ entry }) => (entry as any).texture)
        expect(textures({})).toEqual(['minecraft:entity/wolf/wolf'])
        expect(textures({ 23: 0 })).toEqual(['minecraft:entity/wolf/wolf_ashen'])
        // tame: bit 4 of the flags byte; collar: dye color id 11 (blue), drawn tinted
        const tame = composeEntityLook(wolf, { metadata: { 18: 4, 21: 11, 23: 0 } })
        expect(tame.map(({ entry }) => (entry as any).texture)).toEqual(['minecraft:entity/wolf/wolf_ashen_tame', 'minecraft:entity/wolf/wolf_collar'])
        expect((tame[1]!.entry as any).tint).toBe(-12827478)
    })

    test('looks follow variants and age: cows', () => {
        const cow = store.getEntity('26.3', 'cow')!
        const texture = (metadata: Record<number, unknown>) => composeEntityLook(cow, { metadata }).map(({ entry }) => (entry as any).texture)
        expect(texture({})).toEqual(['minecraft:entity/cow/cow_temperate'])
        expect(texture({ 18: 0 })).toEqual(['minecraft:entity/cow/cow_cold'])
        expect(texture({ 16: true, 18: 2 })).toEqual(['minecraft:entity/cow/cow_warm_baby'])
    })

    test('equipment adds layers: a saddled pig', () => {
        const pig = store.getEntity('26.3', 'pig')!
        expect(composeEntityLook(pig, { equipment: { saddle: 'saddle' } }).map(({ entry }) => (entry as any).texture)).toEqual([
            'minecraft:entity/pig/pig_temperate',
            'minecraft:entity/equipment/pig_saddle/saddle',
        ])
    })

    test('a bit of a shared byte is compared under its mask: a red sheared sheep', () => {
        const sheep = store.getEntity('26.3', 'sheep')!
        const keys = (wool: number) => composeEntityLook(sheep, { metadata: { 18: wool } }).map(({ key }) => key)
        // a colored sheep also draws the tinted undercoat, which shearing keeps
        expect(keys(0)).toEqual(['minecraft:sheep#main#1', 'minecraft:sheep#wool#1'])
        expect(keys(14)).toEqual(['minecraft:sheep#main#1', 'minecraft:sheep#wool#1', 'minecraft:sheep#wool_undercoat#1'])
        expect(keys(14 | 0x10)).toEqual(['minecraft:sheep#main#1', 'minecraft:sheep#wool_undercoat#1'])
        expect(keys(0x10)).toEqual(['minecraft:sheep#main#1'])
    })
})

describe('merging exports', () => {
    const entity = (texture: string): EntityDefinition => ({ renderer: 'R', states: [{ name: 'default', when: [], look: { 'm#1': { type: 'model', model: 'm', texture, renderType: 'entity_cutout', transform: [] } } }] })
    const exported = (version: string, texture: string, extra: Record<string, EntityDefinition> = {}): EntityModelsExport => ({
        version, format: 1, models: { m: { textureSize: [64, 64], root: {} } }, entities: { cow: entity(texture), ...extra }, animations: {},
    })

    test('keeps the newest as latest and older values under the version that changed them', () => {
        const merged = mergeEntityExports([exported('1.16.5', 'cow'), exported('1.21.4', 'cow'), exported('26.3', 'cow_temperate', { happy_ghast: entity('happy_ghast') })])
        expect(merged.versions).toEqual(['1.16.5', '1.21.4', '26.3'])
        expect(Object.keys(merged.entities)).toEqual(['latest', '26.3'])
        const store = new EntityModelsStore(merged)
        const texture = (version: string) => (store.getEntity(version, 'cow')!.states[0]!.look!['m#1'] as any).texture
        expect(texture('26.3')).toBe('cow_temperate')
        expect(texture('1.21.8')).toBe('cow')
        expect(texture('1.16.5')).toBe('cow')
        expect(store.getModel('1.16.5', 'm')).toEqual({ textureSize: [64, 64], root: {} })
    })
})

describe('entity textures by version', () => {
    test('a version reads an older copy where other-textures keeps one', () => {
        expect(entityTextureFolder(data, 'minecraft:entity/iron_golem/iron_golem', '1.15.2')).toBe('1.19')
        expect(entityTextureFolder(data, 'minecraft:entity/iron_golem/iron_golem', '1.19')).toBe('latest')
        expect(entityTextureFolder(data, 'minecraft:entity/iron_golem/iron_golem', '26.3')).toBe('latest')
    })

    test('every folder a version reads a texture from has it', () => {
        const missing: string[] = []
        for (const version of data.versions) {
            for (const texture of Object.keys(data.textureVersions ?? {})) {
                const folder = entityTextureFolder(data, texture, version)
                if (!fs.existsSync(path.join('./dist/other-textures', folder, `${texture}.png`))) missing.push(`${version}: ${folder}/${texture}`)
            }
        }
        expect(missing).toEqual([])
    })
})

describe('one file per export', () => {
    test('a world version reads the newest export not newer than it', () => {
        expect(entityModelsExportFor(data.versions, '1.8.8')).toBe('1.8.9')
        expect(entityModelsExportFor(data.versions, '1.12')).toBe('1.11.2')
        expect(entityModelsExportFor(data.versions, '1.21.3')).toBe('1.21.2')
        expect(entityModelsExportFor(data.versions, '26.3')).toBe('26.3')
        expect(entityModelsExportFor(data.versions, '27.1')).toBe('26.3')
    })

    test('each file draws what the merged data draws for its versions', () => {
        const index = JSON.parse(fs.readFileSync('./dist/entityModelsIndex.json', 'utf8')) as EntityModelsIndex
        expect(index.versions).toEqual(data.versions)
        for (const version of data.versions) {
            const single = JSON.parse(fs.readFileSync(`./dist/entityModels/${version}.json`, 'utf8')) as EntityModelsData
            expect(single.exportVersion).toBe(version)
            const own = new EntityModelsStore(single)
            const exported = exports.find(e => e.version === version)!
            for (const name of Object.keys(exported.entities)) expect(own.getEntity(version, name), `${version} ${name}`).toEqual(store.getEntity(version, name))
            for (const layer of Object.keys(exported.models)) expect(own.getModel(version, layer), `${version} ${layer}`).toEqual(store.getModel(version, layer))
        }
    })
})
