package analysis_test

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
)

// shapeCase is one each call written in a case file of its own.
type shapeCase struct {
	name   string
	source string
	want   []facts.ArchShape
	// declarationFiles lists slash-separated paths, relative to the project root, that the site's DeclarationFiles includes.
	declarationFiles []string
	reason           facts.Reason
}

// shapeName is the name of the test run for c.
func shapeName(c shapeCase) string { return c.name }

// shapeSource is the case source of c.
func shapeSource(c shapeCase) string { return c.source }

// eachOver is a case source that declares s with storageType and calls each over it.
func eachOver(storageType string) string {
	return "declare const s: " + storageType + ";\neach(s, () => {});\n"
}

// eachSite returns the one each site of sites, at any depth.
func eachSite(t *testing.T, sites []facts.Site) facts.Site {
	t.Helper()
	var found []facts.Site
	for _, s := range flatten(sites) {
		if s.Op == facts.OpEach {
			found = append(found, s)
		}
	}
	if len(found) != 1 {
		t.Fatalf("each sites = %d, want 1", len(found))
	}
	return found[0]
}

// analyzeCase analyzes the ith case file of program and returns its each site.
func analyzeCase(t *testing.T, program *testProgram, i int) facts.Site {
	t.Helper()
	sites, _ := program.analyze(t, caseFile(i))
	return eachSite(t, sites)
}

// numberField is the field name of kind number, as a numeric default or f32 declares it.
func numberField(name string) facts.Field { return facts.Field{Name: name, Kind: facts.FieldNumber} }

// booleanField is the field name of kind boolean, as a boolean default declares it.
func booleanField(name string) facts.Field { return facts.Field{Name: name, Kind: facts.FieldBoolean} }

// plainField is the field name of kind plain, as a string default or ref declares it.
func plainField(name string) facts.Field { return facts.Field{Name: name, Kind: facts.FieldPlain} }

// positionComponent is Position as positionSource declares it: number fields x and y.
func positionComponent() facts.Component {
	return facts.Component{Name: "Position", Fields: []facts.Field{numberField("x"), numberField("y")}}
}

// velocityComponent is Velocity as componentsSource declares it: dx is f32 and dy a numeric default, both number.
func velocityComponent() facts.Component {
	return facts.Component{Name: "Velocity", Fields: []facts.Field{numberField("dx"), numberField("dy")}}
}

// shieldComponent is Shield as componentsSource declares it: owner is a ref, so its kind is plain.
func shieldComponent() facts.Component {
	return facts.Component{Name: "Shield", Fields: []facts.Field{
		numberField("hp"), booleanField("active"), plainField("label"), plainField("owner"),
	}}
}

// enemyShape is `archetype([Position, Velocity], [Shield, Stunned])`.
func enemyShape() facts.ArchShape {
	return facts.ArchShape{
		Required: []facts.Component{positionComponent(), velocityComponent()},
		Optional: []facts.Component{shieldComponent(), {Name: "Stunned"}},
	}
}

// shipShape is `Archetype([Position], [Shield, Stunned, Boost])`.
func shipShape() facts.ArchShape {
	return facts.ArchShape{
		Required: []facts.Component{positionComponent()},
		Optional: []facts.Component{shieldComponent(), {Name: "Stunned"}, {Name: "Boost"}},
	}
}

// linkedShape is `archetype([Position, ChildOf])`, ChildOf a relation with fields order and pinned.
func linkedShape() facts.ArchShape {
	return facts.ArchShape{Required: []facts.Component{
		positionComponent(),
		{Name: "ChildOf", Fields: []facts.Field{numberField("order"), booleanField("pinned")}, Relation: true},
	}}
}

// resolvedStorageCases holds one each call per storage form whose shape resolves.
func resolvedStorageCases() []shapeCase {
	enemy, ship := []facts.ArchShape{enemyShape()}, []facts.ArchShape{shipShape()}
	return []shapeCase{
		{name: "local register result", want: enemy, source: `const world = createWorld();
const enemies = register(world, Enemy);
each(enemies, () => {});
`},
		{name: "class form", want: ship, source: `const ships = register(createWorld(), Ship);
each(ships, () => {});
`},
		{name: "parameter typed Storage<typeof X>", want: enemy, source: `export function move(s: Storage<typeof Enemy>): void {
	each(s, () => {});
}
`},
		{name: "parameter typed Storage<X>", want: ship, source: `export function move(s: Storage<Ship>): void {
	each(s, () => {});
}
`},
		{name: "imported from another module", want: enemy, declarationFiles: []string{"app/storages.ts"}, source: `import { enemies } from "../storages.js";
each(enemies, () => {});
`},
		{name: "class field", want: ship, source: `export class Game {
	readonly ships = register(createWorld(), Ship);
	run(): void {
		each(this.ships, () => {});
	}
}
`},
		{name: "property chain", want: enemy, source: `const game = { pools: { enemies: register(createWorld(), Enemy) } };
each(game.pools.enemies, () => {});
`},
		{name: "call result", want: enemy, source: `function enemiesOf(world: World): Storage<typeof Enemy> {
	return register(world, Enemy);
}
each(enemiesOf(createWorld()), () => {});
`},
		{name: "getStorage", want: ship, source: "each(getStorage(createWorld(), Ship), () => {});\n"},
		{name: "generic constrained to a storage type", want: enemy, source: `export function move<S extends Storage<typeof Enemy>>(s: S): void {
	each(s, () => {});
}
`},
		{name: "as cast", want: enemy, source: `declare const raw: Storage;
each(raw as Storage<typeof Enemy>, () => {});
`},
		{name: "union of storages sharing one shape", want: ship, source: eachOver("Storage<Ship> | Storage<Hull>")},
		{
			name:   "relation fields from its relation meta",
			want:   []facts.ArchShape{linkedShape()},
			source: eachOver("Storage<typeof Linked>"),
		},
	}
}

// arrayLiteralCases holds each calls over an array literal of storages that resolve.
func arrayLiteralCases() []shapeCase {
	return []shapeCase{
		{name: "one shape per element in order", want: []facts.ArchShape{enemyShape(), shipShape()}, source: `const world = createWorld();
each([register(world, Enemy), register(world, Ship)], () => {});
`},
		{
			name: "comma inside a component name stays one component",
			want: []facts.ArchShape{
				{Required: []facts.Component{{Name: "A,B"}}},
				{Required: []facts.Component{{Name: "A"}, {Name: "B"}}},
			},
			source: `const Joined = archetype([component("A,B")]);
const Split = archetype([component("A"), component("B")]);
const world = createWorld();
each([register(world, Joined), register(world, Split)], () => {});
`,
		},
	}
}

func TestAnalyze_ResolvesStorageShapes(t *testing.T) {
	t.Parallel()
	cases := slices.Concat(resolvedStorageCases(), arrayLiteralCases())
	program := caseProject(t, "", valuesOf(cases, shapeSource))
	runCases(t, cases, shapeName, func(t *testing.T, i int, tt shapeCase) {
		wantFiles := projectFiles(program, tt.declarationFiles...)

		site := analyzeCase(t, program, i)

		if len(site.Reasons) != 0 {
			t.Fatalf("Analyze(%s) reasons = %v, want none", tt.name, site.Reasons)
		}
		if diff := cmp.Diff(tt.want, site.Shapes, cmpopts.EquateEmpty()); diff != "" {
			t.Errorf("Analyze(%s) shapes mismatch (-want +got):\n%s", tt.name, diff)
		}
		for _, want := range wantFiles {
			if !slices.Contains(site.DeclarationFiles, want) {
				t.Errorf("Analyze(%s) DeclarationFiles = %q, want it to include %s", tt.name, site.DeclarationFiles, want)
			}
		}
	})
}

// unresolvedStorageCases holds one each call per storage form whose shape cannot resolve.
func unresolvedStorageCases() []shapeCase {
	return []shapeCase{
		{name: "wide Storage", source: eachOver("Storage")},
		{name: "union of storages with different shapes", source: eachOver("Storage<typeof Enemy> | Storage<Ship>")},
		{name: "any", source: eachOver("any")},
		{name: "unknown", source: `declare const s: unknown;
// @ts-expect-error -- unknown is not a storage
each(s, () => {});
`},
		{name: "unconstrained type parameter", source: `export function move<S>(s: S): void {
	// @ts-expect-error -- S is not a storage
	each(s, () => {});
}
`},
		{name: "conditional component tuple", source: `type Choose<T> = T extends string ? readonly [typeof Position] : readonly [typeof Velocity];
export function move<T>(s: Storage<ArchetypeDescriptor<Choose<T>>>): void {
	each(s, () => {});
}
`},
		{name: "mapped component tuple", source: `type Positions<T extends readonly unknown[]> = { readonly [K in keyof T]: typeof Position };
export function move<T extends readonly unknown[]>(s: Storage<ArchetypeDescriptor<Positions<T>>>): void {
	each(s, () => {});
}
`},
	}
}

// unpinnedTupleCases holds component tuples whose type does not pin the runtime list or names.
func unpinnedTupleCases() []shapeCase {
	return []shapeCase{
		{name: "rest element", source: `declare const extras: (typeof Velocity)[];
const Mixed = archetype([Position, ...extras]);
declare const s: Storage<typeof Mixed>;
each(s, () => {});
`},
		{name: "rest element among optionals", source: `declare const extras: (typeof Velocity)[];
const Mixed = archetype([Position], [Velocity, ...extras]);
declare const s: Storage<typeof Mixed>;
each(s, () => {});
`},
		{name: "optional element", source: `// @ts-expect-error -- a tuple with an optional element is not a component list
declare const s: Storage<ArchetypeDescriptor<readonly [typeof Position, (typeof Velocity)?]>>;
// @ts-expect-error -- no each overload accepts a storage of that invalid descriptor
each(s, () => {});
`},
		// T's constraint carries Velocity's literal name, so only the element's variadic flag rejects it.
		{name: "variadic element", source: `export function move<T extends readonly (typeof Velocity)[] & typeof Velocity>(s: Storage<ArchetypeDescriptor<readonly [typeof Position, ...T], readonly []>>): void {
	each(s, () => {});
}
`},
		{name: "union-typed element", source: `declare const pick: typeof Position | typeof Velocity;
const Picked = archetype([pick]);
declare const s: Storage<typeof Picked>;
each(s, () => {});
`},
		{name: "component name typed string", source: `declare const name: string;
const Named = component(name, { x: 0 });
const Wide = archetype([Named]);
declare const s: Storage<typeof Wide>;
each(s, () => {});
`},
		{name: "optional component name typed as a union of literals", source: `declare const flag: boolean;
const Either = component(flag ? "Left" : "Right");
const Picked = archetype([Position], [Either]);
declare const s: Storage<typeof Picked>;
each(s, () => {});
`},
	}
}

// dynamicStoragesCases holds each calls whose storages argument cannot be unrolled.
func dynamicStoragesCases() []shapeCase {
	return []shapeCase{
		{name: "storages argument not an array literal", reason: facts.ReasonStoragesDynamic, source: `const list = [register(createWorld(), Enemy)];
each(list, () => {});
`},
		{name: "array literal with an unresolved element", reason: facts.ReasonStoragesDynamic, source: `declare const wide: Storage;
each([register(createWorld(), Enemy), wide], () => {});
`},
		{name: "array literal with a spread element", reason: facts.ReasonStoragesDynamic, source: `const list = [register(createWorld(), Enemy)];
each([...list], () => {});
`},
	}
}

// failedResolutionCases holds every case whose resolution fails, its reason defaulting to SHAPE_UNRESOLVED.
func failedResolutionCases() []shapeCase {
	cases := slices.Concat(unresolvedStorageCases(), unpinnedTupleCases(), dynamicStoragesCases())
	for i := range cases {
		if cases[i].reason == facts.ReasonNone {
			cases[i].reason = facts.ReasonShapeUnresolved
		}
	}
	return cases
}

func TestAnalyze_WhenStorageShapeUnresolved_RecordsReason(t *testing.T) {
	t.Parallel()
	cases := failedResolutionCases()
	program := caseProject(t, "", valuesOf(cases, shapeSource))
	runCases(t, cases, shapeName, func(t *testing.T, i int, tt shapeCase) {
		site := analyzeCase(t, program, i)

		if want := []facts.Reason{tt.reason}; !slices.Equal(site.Reasons, want) {
			t.Errorf("Analyze(%s) reasons = %v, want %v", tt.name, site.Reasons, want)
		}
		if len(site.Shapes) != 0 {
			t.Errorf("Analyze(%s) shapes = %+v, want none", tt.name, site.Shapes)
		}
	})
}

func TestAnalyze_WhenEachStorageResolves_ListsConsultedDeclarationFiles(t *testing.T) {
	t.Parallel()
	program := caseProject(t, "", []string{eachOver("Storage<Ship>")})
	want := projectFiles(program,
		"app/archetypes.ts",
		"app/components.ts",
		"app/position.ts",
		"src/archetype.ts",
		"src/component.ts",
		"src/world.ts",
	)

	site := analyzeCase(t, program, 0)

	if !slices.Equal(site.DeclarationFiles, want) {
		t.Errorf("DeclarationFiles = %q, want %q", site.DeclarationFiles, want)
	}
}

// projectFiles returns paths, slash-separated and relative to program's root, as absolute files.
func projectFiles(program *testProgram, paths ...string) []string {
	files := make([]string, 0, len(paths))
	for _, rel := range paths {
		files = append(files, filepath.ToSlash(treePath(program.dir, rel)))
	}
	return files
}
