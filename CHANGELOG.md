# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add the `ecstatic/vite` plugin, which compiles a single-storage, unfiltered `each()` call with an
  inline callback into a loop over the storage's columns

### Changed

- Reject every `Object.prototype` member name (`__proto__`, `constructor`, `toString`, and the
  rest) as a component name in `archetype()` and `Archetype()`, alongside the other names reserved
  on archetypes
- Reject two distinct component descriptors that share a name in `archetype()` and `Archetype()`,
  as when two installed copies of the package each declare it; the second used to replace the first
- Make a view's `id`, field, and optional-slot accessors enumerable, so `Object.keys`,
  `JSON.stringify`, and spread see a view's fields and slots as they see its required components

### Fixed

- Run a getter in a values record once in `enable`, `enableMany`, `link`, and `setResource`, and
  read an optional relation's `target` once in `spawn` and `spawnMany`, so a getter that returns a
  different value on a second read no longer loses its write
- Keep a field value whose getter grows the storage (by spawning into it) in `enable`, `enableMany`,
  and `link`; the write used to land in the replaced column and the field read its default

## [0.5.0] - 2026-10-16

### Added

- Export `DEBUG` so application code can branch on whether debug checks are active

### Changed

- Return the existing registration from `component()`, `components()`, `relation()`, and
  `resource()` when re-declared with an equal shape instead of throwing
- **Breaking:** Read the debug opt-out from a bare `NDEBUG` global define instead of
  `process.env.NDEBUG`. Set `define: { NDEBUG: "true" }` in esbuild/Vite, or, without a bundler, set
  `globalThis.NDEBUG = true` before the package is first imported
- **Breaking:** Lower the entity ceiling to 1,048,576 entities per world (was 16,777,216) and the
  generations per slot to 1,023 (was 536,870,911), so a dead ID matches a live entity again once its
  slot has been recycled 1,023 times
- Speed up `get`, `despawn`, and `alive` on recycled slots
- Speed up view field access in `each` and `query` when components share field names

### Fixed

- Stop package imports from failing at load time in browsers and bundlers
- Stop `spawn` and `despawn` from allocating on V8 after a slot has been recycled many times
- Stop a dead ID from passing as alive, and `despawn` from accepting it, while its slot sits empty
  after a generation wrap

## [0.4.0] - 2026-08-10

### Added

- Add resources: world-scoped singletons declared with `resource()` and accessed with
  `getResource()`, `setResource()`, and `resetResource()`
- Add relations: `relation()` declares a reverse-indexed link between entities, maintained with
  `link()`/`unlink()` and read with `getTarget()`
- Add birth links: `spawn`/`spawnMany` seed a required relation's link at spawn time
- Add reverse relation queries: `querySources()`, `getSources()`, `hasSources()`, and
  `countSources()` read the entities linked to a target
- Add class-declared archetypes: extend `Archetype(…)` to give an archetype a name that appears in
  types
- Add archetype-typed entity IDs: `EntityId<Ship>` and `With<Position>` check relation targets and
  `ref` fields at compile time
- Add world-scoped despawn: `despawnMany(world, ids)` despawns entities spanning several archetypes
  in one call, and `despawnMany(world)` despawns every live entity

### Removed

- Stop exporting the `ArchetypeDescriptor` type; `class Ship extends Archetype(…) {}` is the one way
  to name an archetype. Generic helpers constrain on `Storage` instead (`<S extends Storage>`,
  reading the archetype back via `S["archetype"]`)
- Stop exporting internal types (`ComponentDescriptor`, `ComponentFields`, `FieldDescriptor`,
  `FieldValue`, `EachView`, `ViewApplyFilter`, `QueryView`, `SpawnOverrides`,
  `OptionalOverridesFor`, `RelationConstraints`, `RelationDescriptor`, `RelationFields`,
  `ResourceFields`) and the `getRelationMeta` accessor

## [0.3.0] - 2026-08-08

### Added

- Add optional components: declare them in an archetype, toggle them with `enable`/`disable` and
  `enableMany`/`disableMany`, and test them with `has` and `hasAny`
- Add `each` filters and multi-storage iteration: `each` accepts an `{all, any, none}` filter and an
  array of storages to iterate across archetypes in one pass
- Add cross-archetype iteration: `query()` iterates entities across every archetype matching a
  filter

## [0.2.0] - 2026-07-31

### Added

- Add component schemas with typed fields, composed into archetypes
- Add entity spawning and despawning, singly or in batches, with per-entity overrides
- Add typed read and write access to component fields
- Add entity iteration over an archetype's live entities
- Add generational entity IDs that detect stale references to despawned entities
- Add world lifecycle management: creation, archetype registration, and destruction

[Unreleased]: https://github.com/jeffzi/ecstatic/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/jeffzi/ecstatic/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jeffzi/ecstatic/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jeffzi/ecstatic/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeffzi/ecstatic/releases/tag/v0.2.0
