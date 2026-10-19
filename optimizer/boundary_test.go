package main_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"os/exec"
	"slices"
	"strings"
	"testing"

	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/importcheck"
)

// goldenPkg registers the -update flag; every test binary of the module links it.
const goldenPkg = "github.com/jeffzi/ecstatic/optimizer/internal/golden"

// testBinarySuffix ends the import path `go list -test` gives the test binary of a package with tests.
const testBinarySuffix = ".test"

// listTestCommand is the `go list` invocation whose output testBinaryDeps reads.
const listTestCommand = "go list -test -json ./..."

// goList is the stdout of cmd, a `go list` command run from the module root.
func goList(t *testing.T, cmd *exec.Cmd) *bytes.Buffer {
	t.Helper()
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("%s: %v\n%s", cmd, err, stderr.String())
	}
	return &stdout
}

func TestModule_WhenListedWithDeps_RespectsImportBoundaries(t *testing.T) {
	t.Parallel()
	listed := goList(t, exec.CommandContext(t.Context(), "go", "list", "-deps", "-json", "./..."))

	violations, err := importcheck.Check(listed)
	if err != nil {
		t.Fatalf("importcheck.Check() error = %v, want nil", err)
	}

	for _, v := range violations {
		t.Error(v)
	}
}

func TestModule_WhenListed_HasEveryPackageTheRulesName(t *testing.T) {
	t.Parallel()
	listed := goList(t, exec.CommandContext(t.Context(), "go", "list", "./..."))

	packages := strings.Fields(listed.String())

	for _, named := range importcheck.Packages() {
		if !slices.Contains(packages, named) {
			t.Errorf("the boundary rules name %s, which is no package of the module, so its rules check nothing", named)
		}
	}
}

// testBinaryDeps maps each package with tests to its test binary's deps, read from `go list -test -json` output.
func testBinaryDeps(t *testing.T, r io.Reader) map[string][]string {
	t.Helper()
	dec := json.NewDecoder(r)
	binaries := make(map[string][]string)
	for {
		var pkg struct {
			ImportPath string
			Deps       []string
		}
		err := dec.Decode(&pkg)
		if errors.Is(err, io.EOF) {
			return binaries
		}
		if err != nil {
			t.Fatalf("decode %s: %v", listTestCommand, err)
		}
		if tested, isBinary := strings.CutSuffix(pkg.ImportPath, testBinarySuffix); isBinary {
			binaries[tested] = pkg.Deps
		}
	}
}

func TestModule_WhenListedWithTests_EveryTestBinaryLinksTheUpdateFlag(t *testing.T) {
	t.Parallel()

	binaries := testBinaryDeps(t, goList(t, exec.CommandContext(t.Context(), "go", "list", "-test", "-json", "./...")))

	if len(binaries) == 0 {
		t.Errorf("%s listed no test binary", listTestCommand)
	}
	for _, tested := range slices.Sorted(maps.Keys(binaries)) {
		if !slices.Contains(binaries[tested], goldenPkg) {
			t.Errorf("package %s has tests but none of its test files imports %s, so go test ./... -update fails there",
				tested, goldenPkg)
		}
	}
}
