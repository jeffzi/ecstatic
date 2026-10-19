package fatal_test

import (
	"os"
	"testing"

	"github.com/jeffzi/ecstatic/optimizer/internal/fatal"
	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
)

func TestRecorder_Run_WhenHelperCallsFatalf_StopsItReturningTheMessage(t *testing.T) {
	t.Parallel()
	recorder := &fatal.Recorder{TB: t}
	continued := false

	got := recorder.Run(func(tb testing.TB) {
		tb.Fatalf("read %s: %v", "banana.ts", "missing")
		continued = true
	})

	if got != "read banana.ts: missing" {
		t.Errorf("Run() = %q, want %q", got, "read banana.ts: missing")
	}
	if continued {
		t.Error("Run() let the helper continue past Fatalf, want it stopped")
	}
}

func TestRecorder_Run_WhenReusedAfterAFailure_ReturnsEmptyForAHelperThatReturns(t *testing.T) {
	t.Parallel()
	recorder := &fatal.Recorder{TB: t}
	recorder.Run(func(tb testing.TB) { tb.Fatalf("banana") })

	got := recorder.Run(func(testing.TB) {})

	if got != "" {
		t.Errorf("second Run() = %q, want empty", got)
	}
}

func TestRecorder_TempDir_WhenPathSet_ReturnsIt(t *testing.T) {
	t.Parallel()
	recorder := &fatal.Recorder{TB: t, TempDirPath: "/banana"}

	got := recorder.TempDir()

	if got != "/banana" {
		t.Errorf("TempDir() = %q, want %q", got, "/banana")
	}
}

func TestRecorder_TempDir_WhenPathNotSet_ReturnsANewDirectory(t *testing.T) {
	t.Parallel()
	recorder := &fatal.Recorder{TB: t}

	got := recorder.TempDir()

	info, err := os.Stat(got)
	if err != nil || !info.IsDir() {
		t.Errorf("TempDir() = %q, stat error = %v, want an existing directory", got, err)
	}
}
