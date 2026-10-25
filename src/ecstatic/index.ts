export { DEBUG } from "./debug.js";
export { VERSION } from "./version.js";

export type { ComponentsOf, OptionalsOf } from "./archetype.js";
export { Archetype, archetype } from "./archetype.js";
export {
  type Component,
  component,
  components,
  f32,
  f64,
  i8,
  i16,
  i32,
  type RefMarker,
  ref,
  type Tag,
  u8,
  u16,
  u32,
} from "./component.js";
export { get, getTarget, set } from "./entity/access.js";
export { alive } from "./entity/common.js";
export { link, unlink } from "./entity/relation.js";
export { despawn, despawnMany } from "./entity/despawn.js";
export { each } from "./entity/each.js";
export type { EachFilter, QueryFilter } from "./filter.js";
export { query } from "./query.js";
export { countSources, getSources, hasSources, querySources } from "./query-sources.js";
export { type Relation, relation } from "./relation.js";
export { type Resource, getResource, resetResource, resource, setResource } from "./resource.js";
export { has, hasAny } from "./entity/has.js";
export { disable, disableMany, enable, enableMany } from "./entity/optional.js";
export { spawn, spawnMany } from "./entity/spawn.js";
export type { EntityId, With } from "./entity-id.js";
export type { Storage, World } from "./world.js";
export { createWorld, destroyWorld, getStorage, register } from "./world.js";
