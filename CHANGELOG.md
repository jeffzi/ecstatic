# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `DEBUG` is now exported, so application code can branch on whether debug checks are active

### Changed

- `component()`, `components()`, `relation()`, and `resource()` return the existing registration
  when re-declared with an equal shape instead of throwing; a different shape still throws a
  conflict error
- Debug checks opt out via a bare `NDEBUG` global define (`define: { NDEBUG: "true" }` in
  esbuild/Vite, or `globalThis.NDEBUG = true` without a bundler) instead of `process.env.NDEBUG`

### Fixed

- Package imports in browsers and bundlers no longer fail at load time (`node:module` and `process`
  references removed from `src/`)

## [0.4.0] - 2026-08-10

### Added

- Resources: world-scoped singletons declared with `resource()`, read as a live mutable reference
  with `getResource()`, updated field by field with `setResource()`, and restored to their declared
  defaults with `resetResource()`
- Relations: `relation()` declares a reverse-indexed link between entities, optionally carrying its
  own fields and constrained to targets that have given components; `link()` and `unlink()` maintain
  the link, and `getTarget()` reads it
- Birth links: a required relation is a mandatory spawn key, so `spawn`/`spawnMany` seed the link
  from `{ target, ...fields }` and reject a missing or stale target
- Reverse relation queries: `querySources()` iterates every entity linked to a target and takes the
  same `{all, any, none}` filter as `each`, `getSources()` returns them as an array or fills a
  caller-supplied one, and `hasSources()`/`countSources()` answer without materializing anything
- Class-declared archetypes: `class Ship extends Archetype([Position, Health], [Frozen]) {}` names
  an archetype, and the name appears in `Storage<Ship>`, `EntityId<Ship>`, and iteration views
  instead of a structural component list
- Archetype-typed entity IDs: `EntityId<Ship>` accepts only IDs spawned from that archetype, and
  `With<Position>` only IDs whose archetype carries that component, so relation targets and `ref`
  fields are checked at compile time
- World-scoped despawn: `despawnMany(world, ids)` despawns entities spanning several archetypes in
  one call, and `despawnMany(world)` despawns every live entity

### Removed

- The `ArchetypeDescriptor` type is no longer exported; `class Ship extends Archetype(…) {}` is the
  one way to name an archetype. Generic helpers constrain on `Storage` instead
  (`<S extends Storage>`, reading the archetype back via `S["archetype"]`)
- Internal types are no longer exported:
  - `ComponentDescriptor`
  - `ComponentFields`
  - `FieldDescriptor`
  - `FieldValue`
  - `EachView`
  - `ViewApplyFilter`
  - `QueryView`
  - `SpawnOverrides`
  - `OptionalOverridesFor`
  - `RelationConstraints`
  - `RelationDescriptor`
  - `RelationFields`
  - `ResourceFields`
  - `getRelationMeta` (accessor)
- The public types are the ones user code names directly:
  - `Component`
  - `Tag`
  - `RefMarker`
  - `EntityId`
  - `With`
  - `Storage`
  - `World`
  - `Relation`
  - `Resource`
  - `EachFilter`
  - `QueryFilter`
  - `ComponentsOf`
  - `OptionalsOf`

### Fixed

- Editor hovers print a component's resolved field record instead of the internal `InferFields<…>`
  alias, everywhere the component type flows — archetypes, spawn overrides, and views
- Hovers for a filtered `each()` view read as the view's own fields, no longer padded with empty
  `Omit`/`&` wrappers for the filter axes left unused
- Spawn overrides hover and report errors as one flat object instead of an intersection padded with
  empty members

## [0.3.0] - 2026-08-08

### Added

- Optional components: declare components as optional in an archetype and toggle them with
  `enable`/`disable` on one entity, or `enableMany`/`disableMany` on a list of entities or a whole
  storage; set their initial state at spawn time via `spawn`/`spawnMany` overrides (`true`, `false`,
  or a field record per optional)
- Optional-component checks: `has` tests whether optional components are enabled and narrows the
  storage type at compile time; `hasAny` returns true when at least one of the listed optionals is
  enabled
- Iteration filters: `each` accepts an `{all, any, none}` filter object (or a bare component array
  as `{all}` shorthand) to iterate only entities that have every `all` component, at least one `any`
  component, and no `none` component
- Multi-storage iteration: `each` accepts an array of storages to iterate across archetypes in one
  pass
- Cross-archetype iteration (`query()`): iterate entities across every archetype matching a filter,
  in one call; hoist the filter object to reuse the cached archetype resolution, since a fresh
  object literal re-resolves on every call

## [0.2.0] - 2026-07-31

### Added

- Component schemas with typed fields, composed into archetypes
- Entity spawning and despawning, singly or in batches, with per-entity overrides
- Typed read and write access to component fields
- Entity iteration over an archetype's live entities
- Generational entity IDs that detect stale references to despawned entities
- World lifecycle management: creation, archetype registration, and destruction

[Unreleased]: https://github.com/jeffzi/ecstatic/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/jeffzi/ecstatic/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jeffzi/ecstatic/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeffzi/ecstatic/releases/tag/v0.2.0
