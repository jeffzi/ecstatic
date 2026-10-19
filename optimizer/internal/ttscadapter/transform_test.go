package ttscadapter_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/printed"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
)

// packageRootProject is the runtime project with an async each call in src/extra.ts and dist/extra.ts, which
// analysis leaves unreported, and in app/main.ts, which it reports.
func packageRootProject(t *testing.T) map[string]string {
	t.Helper()
	return project.Runtime(t, map[string]string{
		"src/extra.ts":  packageRootCall("./index.js"),
		"dist/extra.ts": packageRootCall("../src/index.js"),
		mainFile:        packageRootCall("../src/index.js"),
	})
}

// sourceTexts is files restricted to the non-declaration TypeScript files, keyed like the envelope.
func sourceTexts(files map[string]string) map[string]string {
	texts := map[string]string{}
	for name, text := range files {
		if strings.HasSuffix(name, ".ts") && !strings.HasSuffix(name, ".d.ts") {
			texts[name] = text
		}
	}
	return texts
}

// diagnosticFiles is the file of each of diagnostics, in order.
func diagnosticFiles(diagnostics []ttscadapter.Diagnostic) []string {
	var files []string
	for _, d := range diagnostics {
		files = append(files, d.File)
	}
	return files
}

// loadedGraph is the transform graph ttsc computes for the project at dir, as decoded JSON.
func loadedGraph(t *testing.T, dir string) any {
	t.Helper()
	prog, _, err := driver.LoadProgram(dir, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatalf("driver.LoadProgram(%q) error = %v, want nil", dir, err)
	}
	t.Cleanup(func() {
		if err := prog.Close(); err != nil {
			t.Errorf("Program.Close() error = %v, want nil", err)
		}
	})
	return decodedJSON(t, driver.NewTransformGraph(prog, dir))
}

// sourceMap is the part of a version 3 source map the tests read.
type sourceMap struct {
	Mappings       string   `json:"mappings"`
	SourcesContent []string `json:"sourcesContent"`
	Version        int      `json:"version"`
}

// base64VLQ is the alphabet of the base64 VLQ digits of source map mappings.
const base64VLQ = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// decodeVLQ is the fields of segment, one segment of source map mappings, as the deltas it encodes.
func decodeVLQ(t *testing.T, segment string) []int {
	t.Helper()
	var fields []int
	value, shift := 0, 0
	for _, c := range segment {
		digit := strings.IndexRune(base64VLQ, c)
		if digit < 0 {
			t.Fatalf("mappings segment %q holds %q, which is no base64 VLQ digit", segment, c)
		}
		value |= (digit & 31) << shift
		if digit&32 != 0 {
			shift += 5
			continue
		}
		fields = append(fields, value>>1*(1-2*(value&1)))
		value, shift = 0, 0
	}
	return fields
}

// mappedPosition is the 0-based original line and column that mappings gives the 0-based generated line and column:
// those of the last segment on that line at or before the column, with mapped false when there is none.
func mappedPosition(t *testing.T, mappings string, line, column int) (originalLine, originalColumn int, mapped bool) {
	t.Helper()
	var state [5]int
	for i, group := range strings.Split(mappings, ";") {
		state[0] = 0
		for segment := range strings.SplitSeq(group, ",") {
			if segment == "" {
				continue
			}
			fields := decodeVLQ(t, segment)
			for j, delta := range fields {
				state[j] += delta
			}
			if i == line && state[0] <= column && len(fields) >= 4 {
				originalLine, originalColumn, mapped = state[2], state[3], true
			}
		}
		if i == line {
			break
		}
	}
	return originalLine, originalColumn, mapped
}

// mappedText is a printed file with the source map that maps it back to its source.
type mappedText struct {
	text      string
	sourceMap json.RawMessage
}

// assertMapsTo fails t unless the source map maps the first occurrence of token in the text to want.
func (m mappedText) assertMapsTo(t *testing.T, token string, want facts.Position) {
	t.Helper()
	offset := strings.Index(m.text, token)
	if offset < 0 {
		t.Fatalf("output = %q, want it to contain %q", m.text, token)
	}
	line := strings.Count(m.text[:offset], "\n")
	column := offset - strings.LastIndex(m.text[:offset], "\n") - 1
	var decoded sourceMap
	if err := json.Unmarshal(m.sourceMap, &decoded); err != nil {
		t.Fatalf("json.Unmarshal(source map) error = %v, want nil", err)
	}
	gotLine, gotColumn, mapped := mappedPosition(t, decoded.Mappings, line, column)
	if !mapped || gotLine != want.Line-1 || gotColumn != want.Column-1 {
		t.Errorf("%q at %d:%d maps to %d:%d (mapped %t), want %d:%d", token, line+1, column+1, gotLine+1, gotColumn+1,
			mapped, want.Line, want.Column)
	}
}

// assertSourceMaps fails t unless sourceMaps holds one version 3 map for each file of sources and no other, each
// carrying that file's source text inline.
func assertSourceMaps(t *testing.T, sourceMaps map[string]json.RawMessage, sources map[string]string) {
	t.Helper()
	if diff := cmp.Diff(slices.Sorted(maps.Keys(sources)), slices.Sorted(maps.Keys(sourceMaps))); diff != "" {
		t.Errorf("sourceMaps files mismatch (-want +got):\n%s", diff)
	}
	for file, text := range sources {
		var got sourceMap
		if err := json.Unmarshal(sourceMaps[file], &got); err != nil {
			t.Errorf("json.Unmarshal(sourceMaps[%s]) error = %v, want nil", file, err)
			continue
		}
		if got.Version != 3 || !slices.Equal(got.SourcesContent, []string{text}) {
			t.Errorf("sourceMaps[%s] = version %d with sourcesContent %q, want version 3 with %q", file, got.Version,
				got.SourcesContent, []string{text})
		}
	}
}

// assertHostInputs fails t unless env lists exactly the files of want, keyed by absolute path, as host inputs,
// each hashed as the SHA-256 of its text in want.
func assertHostInputs(t *testing.T, env envelope, want map[string]string) {
	t.Helper()
	wantHashes := map[string]*string{}
	for file, text := range want {
		sum := sha256.Sum256([]byte(text))
		wantHashes[file] = new(hex.EncodeToString(sum[:]))
	}
	if diff := cmp.Diff(slices.Sorted(maps.Keys(want)), slices.Sorted(slices.Values(env.HostInputs))); diff != "" {
		t.Errorf("hostInputs mismatch (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff(wantHashes, env.HostInputHashes); diff != "" {
		t.Errorf("hostInputHashes mismatch (-want +got):\n%s", diff)
	}
}

func TestRun_WhenTransform_WritesTheProjectEnvelope(t *testing.T) {
	t.Parallel()
	files := mainProject(t)
	dir := project.Write(t, files)
	wantUntouched := sourceTexts(files)
	delete(wantUntouched, mainFile)
	wantDependencies := map[string][]string{
		mainFile: {componentsFile, healthFile, "src/archetype.ts", "src/component.ts", debugFile, "src/world.ts"},
	}
	wantDiagnostics := []ttscadapter.Diagnostic{diagnosticAt(asyncCallPos(t, dir), asyncWarningReport())}
	wantGraph := loadedGraph(t, dir)

	got := runTransform(dir, lenientPlugins)

	requireStatus(t, "transform", got, statusOK)
	env := decodeEnvelope(t, got.stdout)
	rewritten := env.TypeScript[mainFile]
	untouched := maps.Clone(env.TypeScript)
	delete(untouched, mainFile)
	if diff := cmp.Diff(wantUntouched, untouched); diff != "" {
		t.Errorf("typescript mismatch, want every file without a rewrite verbatim (-want +got):\n%s", diff)
	}
	assertCalls(t, rewritten, []string{asyncCall}, []string{moversCall, statuesCall})
	assertSourceMaps(t, env.SourceMaps, map[string]string{mainFile: mainSource})
	mapped := mappedText{text: rewritten, sourceMap: env.SourceMaps[mainFile]}
	mapped.assertMapsTo(t, asyncCall, callPos(t, dir, asyncCall))
	mapped.assertMapsTo(t, printed.RowLoop, callPos(t, dir, moversCall))
	assertHostInputs(t, env, map[string]string{filepath.Join(dir, filepath.FromSlash(debugFile)): files[debugFile]})
	if diff := cmp.Diff(wantDependencies, env.Dependencies); diff != "" {
		t.Errorf("dependencies mismatch (-want +got):\n%s", diff)
	}
	if env.DependenciesComplete != nil {
		t.Errorf("dependenciesComplete = %s, want absent", env.DependenciesComplete)
	}
	if diff := cmp.Diff(wantDiagnostics, env.Diagnostics); diff != "" {
		t.Errorf("diagnostics mismatch (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff(wantGraph, decodedJSON(t, env.Graph)); diff != "" {
		t.Errorf("graph mismatch with ttsc's transform graph (-want +got):\n%s", diff)
	}
}

func TestRun_WhenThePackageRootIsReachedThroughASymlink_RecordsThePhysicalPathOfTheDebugCopy(t *testing.T) {
	t.Parallel()
	dir := writeMainProject(t)
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatalf("os.Symlink(%q, %q) error = %v, want nil", dir, link, err)
	}
	debugPath := filepath.Join(link, filepath.FromSlash(debugFile))
	wantRealpaths := map[string]*string{debugPath: new(filepath.Join(dir, filepath.FromSlash(debugFile)))}

	got := runTransform(link, lenientPlugins)

	requireStatus(t, "transform", got, statusOK)
	env := decodeEnvelope(t, got.stdout)
	if diff := cmp.Diff([]string{debugPath}, env.HostInputs); diff != "" {
		t.Errorf("hostInputs mismatch (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff(wantRealpaths, env.HostInputRealpaths); diff != "" {
		t.Errorf("hostInputRealpaths mismatch (-want +got):\n%s", diff)
	}
}

func TestRun_WhenTransform_KeepsOnlySourceFilesUnderCwd(t *testing.T) {
	t.Parallel()
	parent := project.Write(t, map[string]string{
		"project/tsconfig.json":    `{"compilerOptions":{"noEmit":true,"types":[]},"include":["src", "../outside"]}`,
		"project/src/main.ts":      splitSource,
		"project/src/fruit.ts":     fruitSource,
		"project/src/ambient.d.ts": "declare const orchard: number;\n",
		"outside/extra.ts":         "export const cherry = 2;\n",
	})
	want := map[string]string{
		"src/main.ts":  splitSource,
		"src/fruit.ts": fruitSource,
	}

	got := runTransform(filepath.Join(parent, "project"), noPlugins)

	requireStatus(t, "transform", got, statusOK)
	if diff := cmp.Diff(want, decodeEnvelope(t, got.stdout).TypeScript); diff != "" {
		t.Errorf("typescript mismatch (-want +got):\n%s", diff)
	}
}

func TestRun_WhenTransformRunsTwice_WritesIdenticalEnvelopes(t *testing.T) {
	t.Parallel()
	dir := writeMainProject(t)
	first := runTransform(dir, lenientPlugins)

	second := runTransform(dir, lenientPlugins)

	if first.status != statusOK || second.status != statusOK {
		t.Fatalf("Run(transform) = %d then %d, want %d both times", first.status, second.status, statusOK)
	}
	if first.stdout != second.stdout {
		t.Errorf("second envelope differs from the first:\n%s\nwant:\n%s", second.stdout, first.stdout)
	}
}

// namesSource declares, beside an inlined each call, every name a generated name of the loop could take.
const namesSource = `import { archetype, each, type Storage } from "../src/index.js";
import { Position, Velocity } from "./components.js";

const Mover = archetype([Position, Velocity]);
declare const movers: Storage<typeof Mover>;
const ecstatic_internal = 1;
const DEBUG = 2;
const shapeKey = 3;
const storage = 4;
const n = 5;
const i = 6;
const entities = 7;

each(movers, (e) => {
	e.Position.x += ecstatic_internal + DEBUG + shapeKey + storage + n + i + entities + e.id;
});
`

func TestRun_WhenTransform_PrintsEveryGeneratedNameApartFromTheUserNames(t *testing.T) {
	t.Parallel()
	dir := project.Write(t, runtimeProject(t, namesSource))
	userNames := []string{"Mover", "ecstatic_internal", "DEBUG", "shapeKey", "storage", "n", "i", "entities"}

	got := runTransform(dir, lenientPlugins)

	requireStatus(t, "transform", got, statusOK)
	text := decodeEnvelope(t, got.stdout).TypeScript[mainFile]
	if !strings.Contains(text, printed.RowLoop) {
		t.Fatalf("typescript[%s] = %q, want the each call inlined", mainFile, text)
	}
	printed.AssertDeclaredOnce(t, text, userNames)
}

// packageRootCall is an each call that bails as async, importing the runtime from importPath.
func packageRootCall(importPath string) string {
	return `import { archetype, component, each, type Storage } from "` + importPath + `";

const Spot = component("Spot", { x: 0 });
const Marker = archetype([Spot]);
declare const markers: Storage<typeof Marker>;

each(markers, async (e) => {
	e.Spot.x = 1;
});
`
}

func TestRun_WhenFileIsInsideThePackageRoot_LeavesItUnreported(t *testing.T) {
	t.Parallel()
	files := packageRootProject(t)
	dir := project.Write(t, files)
	want := []string{absolute(dir, mainFile)}

	got := runTransform(dir, strictPlugins)

	if got.status != statusDiagnostics {
		t.Fatalf("Run(transform) = %d, want %d for the strict diagnostic in app/main.ts; stderr = %q",
			got.status, statusDiagnostics, got.stderr)
	}
	env := decodeEnvelope(t, got.stdout)
	if diff := cmp.Diff(want, diagnosticFiles(env.Diagnostics)); diff != "" {
		t.Errorf("diagnostic files mismatch (-want +got):\n%s", diff)
	}
	for _, rel := range []string{"src/extra.ts", "dist/extra.ts"} {
		if env.TypeScript[rel] != files[rel] {
			t.Errorf("typescript[%s] = %q, want its original text %q", rel, env.TypeScript[rel], files[rel])
		}
	}
}
