import { createRequire } from "node:module";

import { readPackageVersion } from "./version.js";

/** SemVer version string of the ecstatic package. */
export const VERSION: string = readPackageVersion(
  createRequire(import.meta.url)("../package.json"),
);

export type { ArchetypeDescriptor, ComponentsOf, OptionalsOf } from "./archetype.js";
export { archetype } from "./archetype.js";
export {
  type Component,
  type ComponentDescriptor,
  type ComponentFields,
  component,
  components,
  type FieldDescriptor,
  type FieldValue,
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
export { type EachView, type ViewApplyFilter, each } from "./entity/each.js";
export type { EachFilter, QueryFilter } from "./filter.js";
export { type QueryView, query } from "./query.js";
export {
  type Relation,
  type RelationConstraints,
  type RelationDescriptor,
  type RelationFields,
  getRelationMeta,
  relation,
} from "./relation.js";
export {
  type Resource,
  type ResourceFields,
  getResource,
  resetResource,
  resource,
  setResource,
} from "./resource.js";
export {
  type OptionalOverridesFor,
  disable,
  disableMany,
  enable,
  enableMany,
  has,
  hasAny,
} from "./entity/optional.js";
export { type SpawnOverrides, spawn, spawnMany } from "./entity/spawn.js";
export type { EntityId, With } from "./entity-id.js";
export type { Storage, World } from "./world.js";
export { createWorld, destroyWorld, getStorage, register } from "./world.js";
