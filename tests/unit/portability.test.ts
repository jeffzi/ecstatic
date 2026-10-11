import { runInNewContext } from "node:vm";

import { build, type BuildResult } from "esbuild";
import { assert, describe, expect, it } from "vitest";

interface VmEcs {
  components(defs: Record<string, Record<string, unknown>>): Record<string, unknown>;
  archetype(components: unknown[]): unknown;
  createWorld(): unknown;
  register(world: unknown, arch: unknown): unknown;
  spawn(storage: unknown, overrides?: Record<string, unknown>): number;
  despawn(storage: unknown, id: number): void;
  each(storage: unknown, fn: (e: Record<string, Record<string, number>>) => void): void;
  get(storage: unknown, id: number, field: unknown): unknown;
  DEBUG: boolean;
}

async function buildBundle(define?: Record<string, string>): Promise<BuildResult> {
  return build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "ecstatic",
    write: false,
    ...(define !== undefined ? { define } : {}),
  });
}

function evalInBareContext(
  bundle: BuildResult,
  contextExtras: Record<string, unknown> = {},
): VmEcs {
  const outputFiles = bundle.outputFiles;
  assert(outputFiles != null);
  const firstFile = outputFiles[0];
  assert(firstFile != null);
  const code = new TextDecoder().decode(firstFile.contents);
  const context: Record<string, unknown> = { ...contextExtras };
  runInNewContext(code, context);
  return (context as { ecstatic: VmEcs }).ecstatic;
}

describe("portability", () => {
  describe("browser bundle", () => {
    it("succeeds with zero warnings and zero errors", async () => {
      const result = await buildBundle();

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.outputFiles).toHaveLength(1);
    });
  });

  describe("bare VM (no Node globals)", () => {
    it("runs an end-to-end ECS workflow without process or require", async () => {
      const bundle = await buildBundle();
      const ecs = evalInBareContext(bundle);

      const { PortVmPosition: Position } = ecs.components({
        PortVmPosition: { x: 0, y: 0 },
      });

      const Arch = ecs.archetype([Position]);
      const world = ecs.createWorld();
      const storage = ecs.register(world, Arch);

      const id = ecs.spawn(storage, { PortVmPosition: { x: 10, y: 20 } });

      const visited: number[] = [];
      ecs.each(storage, (e) => {
        visited.push(e.id as unknown as number);
        expect(e.PortVmPosition?.x).toBe(10);
        expect(e.PortVmPosition?.y).toBe(20);
      });

      expect(visited).toStrictEqual([id]);
    });

    it("has DEBUG === true when NDEBUG is not defined", async () => {
      const bundle = await buildBundle();
      const ecs = evalInBareContext(bundle);

      expect(ecs.DEBUG).toBe(true);
    });

    it("throws on stale entity access when DEBUG is true", async () => {
      const bundle = await buildBundle();
      const ecs = evalInBareContext(bundle);

      const { PortStalePos: Position } = ecs.components({
        PortStalePos: { x: 0, y: 0 },
      });

      const Arch = ecs.archetype([Position]);
      const world = ecs.createWorld();
      const storage = ecs.register(world, Arch);

      const id = ecs.spawn(storage);
      ecs.despawn(storage, id);

      expect(() => {
        ecs.get(storage, id, (Position as Record<string, unknown>).x);
      }).toThrow("stale entity ID");
    });
  });

  describe("stripped bundle (NDEBUG defined)", () => {
    it("has DEBUG === false", async () => {
      const bundle = await buildBundle({ NDEBUG: "true" });
      const ecs = evalInBareContext(bundle);

      expect(ecs.DEBUG).toBe(false);
    });

    it("does not throw on stale entity access", async () => {
      const bundle = await buildBundle({ NDEBUG: "true" });
      const ecs = evalInBareContext(bundle);

      const { PortStrippedPos: Position } = ecs.components({
        PortStrippedPos: { x: 0, y: 0 },
      });

      const Arch = ecs.archetype([Position]);
      const world = ecs.createWorld();
      const storage = ecs.register(world, Arch);

      const id = ecs.spawn(storage);
      ecs.despawn(storage, id);

      expect(() => {
        ecs.get(storage, id, (Position as Record<string, unknown>).x);
      }).not.toThrow();
    });
  });
});
