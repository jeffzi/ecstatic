# ecstatic

Archetype-based static ECS in TypeScript.

## Runtime support

ecstatic runs in browsers (including Pixi.js and Three.js projects), Node ≥ 22, web workers, and
edge runtimes. The package ships pure ECMAScript with no Node builtins, so one build serves every
target. Client simulation code is reusable on the server unchanged.

Debug checks (entity staleness, wrong-storage access) are active by default. Strip them in
production builds with a bundler define:

```js
// esbuild / Vite
define: {
  NDEBUG: "true";
}
```

Without a bundler, set `globalThis.NDEBUG = true` before importing ecstatic.
