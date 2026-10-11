import { describe, expectTypeOf, it } from "vitest";

import type {
  // @ts-expect-error the descriptor type is internal: `class Ship extends Archetype(...)` is the one public way to name an archetype
  ArchetypeDescriptor as _PublicArchetypeDescriptor,
  // @ts-expect-error descriptor internals are not public: `component()` and `components()` build them
  ComponentDescriptor as _PublicComponentDescriptor,
  // @ts-expect-error field record shape is not public: it is an implementation detail of `component()`
  ComponentFields as _PublicComponentFields,
  // @ts-expect-error view shape is not public: `each()` hands the view to the callback
  EachView as _PublicEachView,
  // @ts-expect-error field descriptor internals are not public: fields are reached through the component
  FieldDescriptor as _PublicFieldDescriptor,
  // @ts-expect-error optional override shape is not public: `spawn()` types its own overrides argument
  OptionalOverridesFor as _PublicOptionalOverridesFor,
  // @ts-expect-error query view shape is not public: `query()` returns it already typed
  QueryView as _PublicQueryView,
  // @ts-expect-error relation constraints are not public: `relation()` captures them in the descriptor
  RelationConstraints as _PublicRelationConstraints,
  // @ts-expect-error relation descriptor internals are not public: `relation()` is the public way to build one
  RelationDescriptor as _PublicRelationDescriptor,
  // @ts-expect-error relation field record is not public: fields are reached through the relation
  RelationFields as _PublicRelationFields,
  // @ts-expect-error resource field record is not public: `resource()` captures it in the handle
  ResourceFields as _PublicResourceFields,
  // @ts-expect-error spawn override shape is not public: `spawn()` types its own overrides argument
  SpawnOverrides as _PublicSpawnOverrides,
  // @ts-expect-error spawn override shape is not public: `spawn()` types its own overrides argument
  SpawnOverridesFor as _PublicSpawnOverridesFor,
  // @ts-expect-error filter application is not public: `each()` applies filters internally
  ViewApplyFilter as _PublicViewApplyFilter,
} from "../../src/index.js";
// @ts-expect-error relation metadata is internal: relations are used through `relation()`, `link()`, and `getTarget()`
import { getRelationMeta as _publicGetRelationMeta } from "../../src/index.js";
import type { RelationDescriptor } from "../../src/relation.js";
import { getRelationMeta } from "../../src/relation.js";

/** The types the package promises to keep reachable from its single public entry point. */
export type {
  Component,
  ComponentsOf,
  EachFilter,
  EntityId,
  OptionalsOf,
  QueryFilter,
  RefMarker,
  Relation,
  Resource,
  Storage,
  Tag,
  With,
  World,
} from "../../src/index.js";

describe("relation.js internal exports", () => {
  it("keeps getRelationMeta's signature reachable from its defining module", () => {
    expectTypeOf(getRelationMeta).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(getRelationMeta).returns.toEqualTypeOf<RelationDescriptor | undefined>();
  });
});
