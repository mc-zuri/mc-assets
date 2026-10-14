import { VersionedStore } from './versionedStore'

/**
 * Entity models exported from the game by minecraft-model-generator (custom/entities/<version>/entityModels.json),
 * merged by version into dist/entityModels.json.
 *
 * Geometry is in model space, as the game's layer definitions: pixels, y down, rotations in radians. A model is a part
 * tree: every part has an initial pose and cubes given as the arguments of the game's cube constructor. An entity has
 * states: a default look, and patches with conditions on the entity's synched data (the metadata a client gets) and
 * equipment. See {@link composeEntityLook} for how they combine.
 */

/** x, y, z, xRot, yRot, zRot: ModelPart.translateAndRotate translates by x/16.. then rotates rotationZYX(zRot, yRot, xRot). */
export type EntityPartPose = [number, number, number, number, number, number]

export type EntityModelCube = {
    /** min corner, pixels */
    origin: [number, number, number]
    size: [number, number, number]
    /** texture offset of the cube's uv box, pixels */
    uv: [number, number]
    /** grows the box on every side: one value or per axis */
    inflate?: number | [number, number, number]
    mirror?: boolean
    /** visible faces when not all six, in the game's polygon order (down, up, west, north, east, south) */
    faces?: Array<'down' | 'up' | 'west' | 'north' | 'east' | 'south'>
    /** when the cube divides its uvs by another size than the model's */
    textureSize?: [number, number]
}

export type EntityModelPart = {
    pose?: EntityPartPose
    scale?: [number, number, number]
    cubes?: EntityModelCube[]
    children?: Record<string, EntityModelPart>
}

export type EntityModelLayer = {
    textureSize: [number, number]
    root: EntityModelPart
}

/** A part's pose after the renderer's setupAnim, when it differs from the initial pose. */
export type EntityPartRestPose = {
    /** the whole pose; scale is 1 when not given */
    pose?: EntityPartPose
    scale?: [number, number, number]
    visible?: boolean
    /** the part's own cubes are not drawn, its children are */
    skipDraw?: boolean
}

type EntryBase = {
    /** column major 4x4, in blocks: entity space (the entity facing north, -z) from the model's space */
    transform: number[]
}

export type EntityModelEntry = EntryBase & {
    type: 'model'
    /** layer id, a key of the models */
    model: string
    /** only this part of the layer, with the transform taken before its own pose ("/head") */
    part?: string
    /** minecraft:entity/zombie/zombie -> textures/entity/zombie/zombie.png */
    texture?: string
    /** the game's render type: entity_cutout, entity_translucent, eyes, ... */
    renderType: string
    /** ARGB the texture is multiplied with, as a signed int; white when not given */
    tint?: number
    /** by part path relative to the drawn part ("" is the part itself) */
    pose?: Record<string, EntityPartRestPose>
}

export type EntityBlockEntry = EntryBase & {
    type: 'block'
    /** block state, minecraft:chest[facing=north,type=single,waterlogged=false] */
    block?: string
}

export type EntityItemEntry = EntryBase & {
    type: 'item'
    /** item display context */
    context: string
}

export type EntityCustomEntry = EntryBase & {
    type: 'custom'
    renderType: string
    texture?: string
}

export type EntityLookEntry = EntityModelEntry | EntityBlockEntry | EntityItemEntry | EntityCustomEntry

export type EntityCondition =
    | {
          /** synched data index (minecraft-data's metadataKeys index) */
          index: number
          /** the synched data type (minecraft-data's entityMetadata type names) */
          type?: string
          /** for structured values (villager_data): the field compared */
          field?: string
          /** registry id, enum ordinal, number or boolean */
          value?: number | boolean | string
          /** the enum constant name, for clients that read the value as a name (dye_color) */
          name?: string
          /** compare value & mask */
          mask?: number
          /** holds when the value differs from the default (long values: an anger end time) */
          notDefault?: boolean
      }
    | {
          /** equipment slot: mainhand, offhand, feet, legs, chest, head, body, saddle */
          slot: string
          /** item name without namespace */
          item: string
      }

export type EntityState = {
    name: string
    when: EntityCondition[]
    /** only on the first (default) state */
    look?: Record<string, EntityLookEntry>
    /** on every other state: key -> null (remove), a whole entry (add or replace), or the changed properties (null removes one) */
    patch?: Record<string, Partial<Record<string, unknown>> | null>
}

export type EntityDefinition = {
    /** the game's renderer class */
    renderer: string
    /** for item-like entities (ThrownItemRenderer): the item they show by default */
    item?: string
    /** synched data defaults for the indexes conditions read: the value when the client got none */
    defaults?: Record<string, unknown>
    /** empty for entities that draw nothing (markers) */
    states: EntityState[]
}

export type EntityAnimationKeyframe = {
    t: number
    v: [number, number, number]
    pre?: [number, number, number]
    i: 'linear' | 'catmullrom'
}

export type EntityAnimation = {
    length: number
    looping?: boolean
    bones: Record<string, Array<{ target: 'position' | 'rotation' | 'scale'; keyframes: EntityAnimationKeyframe[] }>>
}

/** One version's export, as minecraft-model-generator writes it. */
export type EntityModelsExport = {
    version: string
    format: number
    models: Record<string, EntityModelLayer>
    entities: Record<string, EntityDefinition>
    animations: Record<string, EntityAnimation>
}

/** dist/entityModels.json: every exported version merged, mc-assets' versioned layout (a version key holds what was before it). */
export type EntityModelsData = {
    versions: string[]
    models: Record<string, Record<string, EntityModelLayer>>
    entities: Record<string, Record<string, EntityDefinition>>
    animations: Record<string, Record<string, EntityAnimation>>
}

export class EntityModelsStore {
    private models = new VersionedStore<EntityModelLayer>()
    private entities = new VersionedStore<EntityDefinition>()
    private animations = new VersionedStore<EntityAnimation>()
    readonly versions: string[]

    constructor(data: EntityModelsData) {
        this.versions = data.versions
        for (const store of [this.models, this.entities, this.animations]) store.inclusive = false
        this.models.loadData(data.models as any)
        this.entities.loadData(data.entities as any)
        this.animations.loadData(data.animations as any)
    }

    /** The oldest exported version is used for older versions. */
    getEntity(version: string, name: string) {
        return this.entities.get(version, name)
    }

    getModel(version: string, layer: string) {
        return this.models.get(version, layer)
    }

    getAnimation(version: string, name: string) {
        return this.animations.get(version, name)
    }
}

/** What a condition reads from an entity: synched data by index (missing: the default) and equipment by slot. */
export type EntityLookInput = {
    metadata?: Record<number, unknown> | unknown[]
    /** equipment by slot name, item names without namespace */
    equipment?: Partial<Record<string, string | undefined>>
}

const toNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number') return value
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'bigint') return Number(value)
    if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) return Number(value)
    return undefined
}

export const conditionHolds = (condition: EntityCondition, entity: EntityDefinition, input: EntityLookInput): boolean => {
    if ('slot' in condition) {
        const item = input.equipment?.[condition.slot]
        return !!item && item.replace(/^minecraft:/, '') === condition.item
    }
    const raw = (input.metadata as any)?.[condition.index]
    const fallback = entity.defaults?.[String(condition.index)]
    let value = raw === undefined || raw === null ? fallback : raw
    if (condition.field && value && typeof value === 'object') value = (value as any)[condition.field]
    if (condition.notDefault) {
        return value !== undefined && value !== null && String(value) !== String(fallback) && String(value) !== '-1'
    }
    if (typeof condition.value === 'boolean') return value === condition.value || toNumber(value) === (condition.value ? 1 : 0)
    if (typeof value === 'string' && condition.name !== undefined && isNaN(Number(value))) return value === condition.name
    const number = toNumber(value)
    if (number === undefined) return false
    if (condition.mask !== undefined) return (number & condition.mask) === condition.value
    return number === condition.value
}

/**
 * The entries an entity draws: the default look, with the patch of every state whose conditions all hold applied in
 * order of how many conditions it has (fewest first, file order among equals). Keys are kept so a renderer can tell
 * the entries apart (`<layer><part>#<n>`, `block#n`, `item#n`, `custom#n`).
 */
export const composeEntityLook = (entity: EntityDefinition, input: EntityLookInput = {}): Array<{ key: string; entry: EntityLookEntry }> => {
    const look = new Map<string, Record<string, unknown>>()
    const [first, ...rest] = entity.states
    if (!first?.look) return []
    for (const [key, entry] of Object.entries(first.look)) look.set(key, structuredClone(entry) as any)
    const matching = rest
        .map((state, index) => ({ state, index }))
        .filter(({ state }) => state.when.every(condition => conditionHolds(condition, entity, input)))
        .sort((a, b) => a.state.when.length - b.state.when.length || a.index - b.index)
    for (const { state } of matching) applyEntityPatch(look, state.patch ?? {})
    return [...look].map(([key, entry]) => ({ key, entry: entry as EntityLookEntry }))
}

export const applyEntityPatch = (look: Map<string, Record<string, unknown>>, patch: NonNullable<EntityState['patch']>) => {
    for (const [key, change] of Object.entries(patch)) {
        if (change === null) {
            look.delete(key)
            continue
        }
        const current = look.get(key)
        if (!current) {
            if ('type' in change) look.set(key, structuredClone(change) as any)
            continue
        }
        for (const [property, value] of Object.entries(change)) {
            if (value === null) delete current[property]
            else current[property] = structuredClone(value)
        }
    }
}

/** Equipment slot names in the order of the game's EquipmentSlot (the protocol's slot ids). */
export const ENTITY_EQUIPMENT_SLOTS = ['mainhand', 'offhand', 'feet', 'legs', 'chest', 'head', 'body', 'saddle'] as const
