// Package project writes the TypeScript projects the module's tests load: a set of files laid out
// in a temp dir, and the repository's runtime sources as such a set.
//
// Only test files import it, so it never links into the sidecar.
package project

import (
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// RuntimeTsconfig mirrors the repository's compiler options, so the runtime sources type-check as they do there.
const RuntimeTsconfig = `{
	"compilerOptions": {
		"strict": true,
		"target": "es2024",
		"lib": ["es2024"],
		"module": "nodenext",
		"exactOptionalPropertyTypes": true,
		"noUncheckedIndexedAccess": true,
		"allowUnreachableCode": false,
		"allowUnusedLabels": false,
		"noImplicitOverride": true,
		"noImplicitReturns": true,
		"noFallthroughCasesInSwitch": true,
		"noPropertyAccessFromIndexSignature": true,
		"verbatimModuleSyntax": true,
		"isolatedModules": true,
		"esModuleInterop": true,
		"noEmit": true,
		"skipLibCheck": true,
		"types": []
	},
	"include": ["**/*.ts"]
}`

const (
	dirPerm  = 0o750
	filePerm = 0o600
)

// bundlerPluginDir is the bundler plugin's path under src/, the only directory readSources leaves out:
// the build excludes src/plugin alone, so a directory named plugin deeper under src/ is a runtime source.
const bundlerPluginDir = "plugin"

// sourceDir holds the runtime sources, under the same name in the repository and in the project.
const sourceDir = "src"

var errNoModule = errors.New("no go.mod in the working directory or above it")

// Write writes files, keyed by slash-separated path, under a new temp dir and returns its resolved path.
func Write(t testing.TB, files map[string]string) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("filepath.EvalSymlinks(t.TempDir()) error = %v, want nil", err)
	}
	for _, rel := range slices.Sorted(maps.Keys(files)) {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		parent := filepath.Dir(path)
		if err := os.MkdirAll(parent, dirPerm); err != nil {
			t.Fatalf("os.MkdirAll(%q) error = %v, want nil", parent, err)
		}
		if err := os.WriteFile(path, []byte(files[rel]), filePerm); err != nil {
			t.Fatalf("os.WriteFile(%q) error = %v, want nil", path, err)
		}
	}
	return dir
}

// Runtime is the repository with its real runtime sources in src/, the bundler plugin left out, plus extra.
//
// It finds the repository as the parent of the Go module holding the working directory, which go
// test sets to the directory of the package under test.
func Runtime(t testing.TB, extra map[string]string) map[string]string {
	t.Helper()
	files := map[string]string{
		"tsconfig.json": RuntimeTsconfig,
		"package.json":  `{"name": "ecstatic", "type": "module"}`,
	}
	if err := readSources(files); err != nil {
		t.Fatalf("read the runtime sources: %v", err)
	}
	maps.Copy(files, extra)
	return files
}

// readSources adds each TypeScript file of the repository's src/ to files, keyed "src/<path>".
func readSources(files map[string]string) error {
	module, err := moduleRoot()
	if err != nil {
		return err
	}
	root := filepath.Join(filepath.Dir(module), sourceDir)
	sources := os.DirFS(root)
	err = fs.WalkDir(sources, ".", func(rel string, entry fs.DirEntry, err error) error {
		switch {
		case err != nil:
			return err
		case entry.IsDir() && rel == bundlerPluginDir:
			return fs.SkipDir
		case entry.IsDir() || !strings.HasSuffix(rel, ".ts"):
			return nil
		}
		content, err := fs.ReadFile(sources, rel)
		if err != nil {
			return err
		}
		files[sourceDir+"/"+rel] = string(content)
		return nil
	})
	if err != nil {
		return fmt.Errorf("walk %s: %w", root, err)
	}
	return nil
}

// moduleRoot is the nearest directory at or above the working directory that holds a go.mod.
func moduleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("get the working directory: %w", err)
	}
	for {
		manifest := filepath.Join(dir, "go.mod")
		_, err := os.Stat(manifest)
		if err == nil {
			return dir, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("look for %s: %w", manifest, err)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errNoModule
		}
		dir = parent
	}
}
