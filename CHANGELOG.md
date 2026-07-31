# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-31

### Added

- Component schemas with typed fields, composed into archetypes
- Entity spawning and despawning, singly or in batches, with per-entity overrides
- Typed read and write access to component fields
- Entity iteration over an archetype's live entities
- Generational entity IDs that detect stale references to despawned entities
- World lifecycle management: creation, archetype registration, and destruction

[Unreleased]: https://github.com/jeffzi/ecstatic/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jeffzi/ecstatic/releases/tag/v0.2.0
