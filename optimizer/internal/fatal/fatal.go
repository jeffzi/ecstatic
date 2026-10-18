// Package fatal records how a testing.TB helper fails, so a test can check the failure of a helper
// without failing itself.
//
// Only test files import it, so it never links into the sidecar.
package fatal

import (
	"fmt"
	"runtime"
	"testing"
)

// Recorder is a testing.TB whose Fatalf records the message and ends the calling goroutine, as
// testing.T's does, without failing the test.
type Recorder struct {
	testing.TB

	// TempDirPath, when not empty, is what TempDir returns in place of the embedded TB's.
	TempDirPath string
	message     string
}

// Fatalf records the formatted message and ends the calling goroutine.
func (r *Recorder) Fatalf(format string, args ...any) {
	r.message = fmt.Sprintf(format, args...)
	runtime.Goexit()
}

// TempDir returns TempDirPath when it is set, and the embedded TB's temp dir otherwise.
func (r *Recorder) TempDir() string {
	if r.TempDirPath != "" {
		return r.TempDirPath
	}
	return r.TB.TempDir()
}

// Run runs helper with r on its own goroutine, so Fatalf ends that goroutine and not the test's,
// and returns the message helper failed with, or "" when it returned without failing.
func (r *Recorder) Run(helper func(testing.TB)) string {
	done := make(chan struct{})
	go func() {
		defer close(done)
		helper(r)
	}()
	<-done
	return r.message
}
