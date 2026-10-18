// Package golden registers the -update flag of the module's golden-file tests.
//
// `go test ./... -update` hands -update to every test binary it builds, and a binary that does not
// define the flag exits with "flag provided but not defined". Every package with tests therefore
// imports this package from one of its test files; the guard in boundary_test.go fails when one
// does not. Only test files import it, so it never links into the sidecar.
package golden

import "flag"

var update = flag.Bool("update", false, "rewrite golden files from the current output") //nolint:gochecknoglobals // a test flag is registered at package level so the test binary parses it

// Update reports whether the test binary was run with -update.
func Update() bool {
	return *update
}
