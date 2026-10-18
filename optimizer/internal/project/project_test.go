package project_test

import (
	"encoding/json"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/jeffzi/ecstatic/optimizer/internal/fatal"
	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
)

func TestWrite_WhenPathsNest_WritesEachFileUnderTheResolvedDirectory(t *testing.T) {
	t.Parallel()
	files := map[string]string{"tsconfig.json": "{}", "src/deep/main.ts": "export {};\n"}

	dir := project.Write(t, files)

	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil || resolved != dir {
		t.Errorf("EvalSymlinks(%s) = %q, %v, want the directory itself", dir, resolved, err)
	}
	written := os.DirFS(dir)
	got := map[string]string{}
	for rel := range files {
		content, err := fs.ReadFile(written, rel)
		if err != nil {
			t.Fatalf("fs.ReadFile(%s) error = %v, want nil", rel, err)
		}
		got[rel] = string(content)
	}
	if diff := cmp.Diff(files, got); diff != "" {
		t.Errorf("Write(%v) files mismatch (-want +got):\n%s", files, diff)
	}
}

func TestWrite_WhenTempDirCannotBeResolved_FailsNamingEvalSymlinks(t *testing.T) {
	t.Parallel()
	recorder := &fatal.Recorder{TB: t, TempDirPath: "/banana/missing"}

	got := recorder.Run(func(tb testing.TB) { project.Write(tb, map[string]string{}) })

	if !strings.Contains(got, "filepath.EvalSymlinks") {
		t.Errorf("Write() fatal = %q, want a failure naming filepath.EvalSymlinks", got)
	}
}

func TestWrite_WhenAFileCannotBeWritten_FailsNamingIt(t *testing.T) {
	t.Parallel()
	tests := []struct {
		files map[string]string
		name  string
		// want is the slash-separated path, relative to the project directory, the failure names.
		want string
	}{
		{name: "parent directory is a file", files: map[string]string{"app": "", "app/main.ts": ""}, want: "app"},
		{name: "path is the project directory", files: map[string]string{"": ""}, want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			base, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatalf("filepath.EvalSymlinks(t.TempDir()) error = %v, want nil", err)
			}
			recorder := &fatal.Recorder{TB: t, TempDirPath: base}
			want := filepath.Join(base, filepath.FromSlash(tt.want))

			got := recorder.Run(func(tb testing.TB) { project.Write(tb, tt.files) })

			if !strings.Contains(got, want) {
				t.Errorf("Write(%v) fatal = %q, want a failure naming %q", tt.files, got, want)
			}
		})
	}
}

func TestRuntime_WhenExtraFilesGiven_AddsThemToTheRuntimeSources(t *testing.T) {
	t.Parallel()
	extra := map[string]string{"app/main.ts": "export {};\n"}

	got := project.Runtime(t, extra)

	if got["tsconfig.json"] != project.RuntimeTsconfig {
		t.Errorf("Runtime() tsconfig.json = %q, want RuntimeTsconfig", got["tsconfig.json"])
	}
	if got["app/main.ts"] != extra["app/main.ts"] {
		t.Errorf("Runtime() app/main.ts = %q, want %q", got["app/main.ts"], extra["app/main.ts"])
	}
	if _, ok := got["src/index.ts"]; !ok {
		t.Error("Runtime() has no src/index.ts, want the runtime sources")
	}
}

// tsconfig is the part of a tsconfig file the runtime project mirrors.
type tsconfig struct {
	CompilerOptions map[string]any `json:"compilerOptions"`
	Exclude         []string       `json:"exclude"`
}

// readRepositoryTsconfig decodes the tsconfig file name at the repository root, three levels above the package directory go test runs in.
func readRepositoryTsconfig(t *testing.T, name string) tsconfig {
	t.Helper()
	content, err := fs.ReadFile(os.DirFS(filepath.Join("..", "..", "..")), name)
	if err != nil {
		t.Fatalf("fs.ReadFile(%s) error = %v, want nil", name, err)
	}
	var config tsconfig
	if err := json.Unmarshal(content, &config); err != nil {
		t.Fatalf("json.Unmarshal(%s) error = %v, want nil", name, err)
	}
	return config
}

func TestRuntimeTsconfig_WhenComparedWithTheBuildConfig_HoldsItsCompilerOptions(t *testing.T) {
	t.Parallel()
	want := readRepositoryTsconfig(t, "tsconfig.json").CompilerOptions
	maps.Copy(want, readRepositoryTsconfig(t, "tsconfig.build.json").CompilerOptions)
	// The runtime project only type-checks, so the build's emit settings stay out of it.
	for _, emitOnly := range []string{"rootDir", "outDir", "declaration", "declarationMap", "sourceMap"} {
		delete(want, emitOnly)
	}
	want["noEmit"] = true

	var got tsconfig
	if err := json.Unmarshal([]byte(project.RuntimeTsconfig), &got); err != nil {
		t.Fatalf("json.Unmarshal(RuntimeTsconfig) error = %v, want nil", err)
	}

	// TypeScript reads target, lib, and module case-insensitively.
	if diff := cmp.Diff(want, got.CompilerOptions, cmp.Comparer(strings.EqualFold)); diff != "" {
		t.Errorf("RuntimeTsconfig compilerOptions mismatch with tsconfig.build.json (-want +got):\n%s", diff)
	}
}

func TestRuntime_WhenComparedWithTheBuildConfig_LeavesOutTheDirectoryTheBuildExcludes(t *testing.T) {
	t.Parallel()
	var excluded []string
	for _, entry := range readRepositoryTsconfig(t, "tsconfig.build.json").Exclude {
		if strings.HasPrefix(entry, "src/") && !strings.ContainsAny(entry, "*?") {
			excluded = append(excluded, entry+"/")
		}
	}
	if len(excluded) == 0 {
		t.Fatal("tsconfig.build.json excludes no directory under src/, want the one Runtime leaves out")
	}

	got := project.Runtime(t, nil)

	var kept []string
	for rel := range got {
		if slices.ContainsFunc(excluded, func(dir string) bool { return strings.HasPrefix(rel, dir) }) {
			kept = append(kept, rel)
		}
	}
	if len(kept) > 0 {
		t.Errorf("Runtime() has %q, want every directory under %q left out", kept, excluded)
	}
}

func TestRuntime_WhenADirectoryNamedPluginIsNested_LeavesOutOnlyTheTopLevelPlugin(t *testing.T) {
	root := project.Write(t, map[string]string{
		"mod/go.mod":                 "module banana\n",
		"src/index.ts":               "export {};\n",
		"src/plugin/index.ts":        "export const bundler = 1;\n",
		"src/feature/plugin/hook.ts": "export const hook = 1;\n",
	})
	t.Chdir(filepath.Join(root, "mod"))

	got := project.Runtime(t, nil)

	if got["src/feature/plugin/hook.ts"] != "export const hook = 1;\n" {
		t.Errorf("Runtime() src/feature/plugin/hook.ts = %q, want the nested runtime source kept", got["src/feature/plugin/hook.ts"])
	}
	if _, ok := got["src/plugin/index.ts"]; ok {
		t.Error("Runtime() has src/plugin/index.ts, want the bundler plugin left out")
	}
}

func TestRuntime_WhenTheSourcesCannotBeRead_FailsNamingTheCause(t *testing.T) {
	named := func(want string) func(string) string { return func(string) string { return want } }
	tests := []struct {
		dir  func(t *testing.T) string
		want func(dir string) string
		name string
	}{
		{name: "no Go module above the working directory", dir: func(t *testing.T) string { return t.TempDir() }, want: named("go.mod")},
		{
			name: "go.mod that cannot be read",
			dir: func(t *testing.T) string {
				dir := project.Write(t, map[string]string{})
				if err := os.Symlink("go.mod", filepath.Join(dir, "go.mod")); err != nil {
					t.Fatalf("os.Symlink() error = %v, want nil", err)
				}
				return dir
			},
			want: func(dir string) string { return filepath.Join(dir, "go.mod") },
		},
		{name: "no source directory beside the module", dir: func(t *testing.T) string { return project.Write(t, map[string]string{"go.mod": "module banana\n"}) }, want: named("src")},
		{
			name: "unreadable source file",
			dir: func(t *testing.T) string {
				root := project.Write(t, map[string]string{"mod/go.mod": "module banana\n", "src/index.ts": "export {};\n"})
				if err := os.Symlink("missing.ts", filepath.Join(root, "src", "broken.ts")); err != nil {
					t.Fatalf("os.Symlink() error = %v, want nil", err)
				}
				return filepath.Join(root, "mod")
			},
			want: named("broken.ts"),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := tt.dir(t)
			t.Chdir(dir)
			recorder := &fatal.Recorder{TB: t}
			want := tt.want(dir)

			got := recorder.Run(func(tb testing.TB) { project.Runtime(tb, nil) })

			if !strings.Contains(got, want) {
				t.Errorf("Runtime() fatal = %q, want it to name %q", got, want)
			}
		})
	}
}
