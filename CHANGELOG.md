# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-08

### Added

- Optional components: declare components as optional in an archetype and toggle them with `enable`/`disable` on one entity, or `enableMany`/`disableMany` on a list of entities or a whole storage; set their initial state at spawn time via `spawn`/`spawnMany` overrides (`true`, `false`, or a field record per optional)
- Optional-component checks: `has` tests whether optional components are enabled and narrows the storage type at compile time; `hasAny` returns true when at least one of the listed optionals is enabled
- Iteration filters: `each` accepts an `{all, any, none}` filter object (or a bare component array as `{all}` shorthand) to iterate only entities that have every `all` component, at least one `any` component, and no `none` component
- Multi-storage iteration: `each` accepts an array of storages to iterate across archetypes in one pass
- Cross-archetype iteration (`query()`): iterate entities across every archetype matching a filter, in one call

## [0.2.0] - 2026-07-31

### Added

- Component schemas with typed fields, composed into archetypes
- Entity spawning and despawning, singly or in batches, with per-entity overrides
- Typed read and write access to component fields
- Entity iteration over an archetype's live entities
- Generational entity IDs that detect stale references to despawned entities
- World lifecycle management: creation, archetype registration, and destruction

[Unreleased]: https://github.com/jeffzi/ecstatic/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jeffzi/ecstatic/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeffzi/ecstatic/releases/tag/v0.2.0
