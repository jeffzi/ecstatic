package golden_test

import (
	"flag"
	"testing"

	"github.com/jeffzi/ecstatic/optimizer/internal/golden"
)

const updateFlag = "update"

func TestUpdate(t *testing.T) {
	registered := flag.Lookup(updateFlag)
	if registered == nil {
		t.Fatalf("flag.Lookup(%q) = nil, want the -update flag go test ./... -update relies on", updateFlag)
	}

	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "flag set to true", value: "true", want: true},
		{name: "flag set to false", value: "false", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			previous := registered.Value.String()
			if err := flag.Set(updateFlag, tt.value); err != nil {
				t.Fatalf("flag.Set(%q, %q) error = %v, want nil", updateFlag, tt.value, err)
			}
			t.Cleanup(func() {
				if err := flag.Set(updateFlag, previous); err != nil {
					t.Errorf("flag.Set(%q, %q) error = %v, want nil", updateFlag, previous, err)
				}
			})

			got := golden.Update()

			if got != tt.want {
				t.Errorf("golden.Update() = %v after -%s=%s, want %v", got, updateFlag, tt.value, tt.want)
			}
		})
	}
}
