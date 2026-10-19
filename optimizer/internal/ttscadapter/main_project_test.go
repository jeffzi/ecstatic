package ttscadapter_test

import (
	"strings"
	"testing"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/position"
	"github.com/jeffzi/ecstatic/optimizer/internal/printed"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
)

const (
	componentsFile = "app/components.ts"
	healthFile     = "app/health.ts"
	mainFile       = "app/main.ts"
)

const componentsSource = `import { component } from "../src/index.js";

export const Position = component("Position", { x: 0, y: 0 });
export const Velocity = component("Velocity", { dx: 0, dy: 0 });
`

const healthSource = `import { component } from "../src/index.js";

export const Health = component("Health", { hp: 0 });
`

// inlinedSource calls each over two storages whose shapes consult different files, both calls compiling to inlined
// loops.
const inlinedSource = `import { archetype, each, type Storage } from "../src/index.js";
import { Position, Velocity } from "./components.js";
import { Health } from "./health.js";

const Mover = archetype([Position, Velocity]);
const Statue = archetype([Position, Health]);
declare const movers: Storage<typeof Mover>;
declare const statues: Storage<typeof Statue>;

each(movers, (e) => {
	e.Position.x += e.Velocity.dx;
});
each(statues, (e) => {
	e.Health.hp = 0;
});
`

// mainSource is inlinedSource calling each once more, with an async callback.
const mainSource = inlinedSource + `each(movers, async (e) => {
	e.Position.y += e.Velocity.dy;
});
`

// asyncCall is the each call in mainSource that the async callback bails.
const asyncCall = "each(movers, async"

// moversCall and statuesCall are the each calls in mainSource that compile to inlined loops.
const (
	moversCall  = "each(movers, (e)"
	statuesCall = "each(statues"
)

// callPos is the position of the first occurrence of call in mainSource, in the main project at dir.
func callPos(t *testing.T, dir, call string) facts.Position {
	t.Helper()
	return position.Of(absolute(dir, mainFile), mainSource, position.Occurrence(t, mainSource, call, 0))
}

// debugFile is the runtime source the DEBUG copy of a rewritten file is taken from, under the package root.
const debugFile = "src/debug.ts"

// assertCalls fails t unless text, the output for mainSource, imports the internal entry, holds a row loop, still
// holds each of kept, and no longer holds any of inlined.
func assertCalls(t *testing.T, text string, kept, inlined []string) {
	t.Helper()
	for _, fragment := range append([]string{printed.NamespaceImport, printed.RowLoop}, kept...) {
		if !strings.Contains(text, fragment) {
			t.Errorf("output = %q, want it to contain %q", text, fragment)
		}
	}
	for _, call := range inlined {
		if strings.Contains(text, call) {
			t.Errorf("output = %q, want the call %q inlined", text, call)
		}
	}
}

// runtimeProject is the runtime project with main as app/main.ts, beside the component files mainSource imports.
func runtimeProject(t *testing.T, main string) map[string]string {
	t.Helper()
	return project.Runtime(t, map[string]string{
		componentsFile: componentsSource,
		healthFile:     healthSource,
		mainFile:       main,
	})
}

// mainProject is the runtime project with mainSource as app/main.ts.
func mainProject(t *testing.T) map[string]string {
	t.Helper()
	return runtimeProject(t, mainSource)
}

// writeMainProject writes mainProject to a new temporary directory and returns its resolved path.
func writeMainProject(t *testing.T) string {
	t.Helper()
	return project.Write(t, mainProject(t))
}

// asyncCallPos is the position of the async each call in mainSource, in the main project at dir.
func asyncCallPos(t *testing.T, dir string) facts.Position {
	t.Helper()
	return callPos(t, dir, asyncCall)
}
