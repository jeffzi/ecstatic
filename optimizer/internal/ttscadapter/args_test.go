package ttscadapter_test

import (
	"errors"
	"testing"

	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
)

type argsCase struct {
	name string
	argv []string
	want ttscadapter.Args
}

// parseArgsCases pairs accepted command lines with the arguments they parse to.
func parseArgsCases() []argsCase {
	return []argsCase{
		{
			name: "transform as ttsc spawns it",
			argv: []string{
				"transform", "--tsconfig=/p/tsconfig.json", `--plugins-json=[{"name":"ecstatic"}]`, "--cwd=/p",
			},
			want: ttscadapter.Args{
				Subcommand:  ttscadapter.SubcommandTransform,
				Tsconfig:    "/p/tsconfig.json",
				PluginsJSON: `[{"name":"ecstatic"}]`,
				Cwd:         "/p",
			},
		},
		{
			name: "build with every build modifier",
			argv: []string{"build", "--cwd=/p", "--emit", "--outDir=/p/dist", "--verbose", "--quiet"},
			want: ttscadapter.Args{
				Subcommand: ttscadapter.SubcommandBuild,
				Cwd:        "/p",
				OutDir:     "/p/dist",
				Emit:       true,
			},
		},
		{
			name: "value flags written as separate arguments",
			argv: []string{
				"check", "--cwd", "/p", "--tsconfig", "/p/tsconfig.json", "--plugins-json", "[]", "--outDir", "/p/out",
			},
			want: ttscadapter.Args{
				Subcommand:  ttscadapter.SubcommandCheck,
				Cwd:         "/p",
				Tsconfig:    "/p/tsconfig.json",
				PluginsJSON: "[]",
				OutDir:      "/p/out",
			},
		},
		{
			name: "unknown flags in either form are ignored",
			argv: []string{"build", "--project-context-json={}", "--banana", "--cwd=/p", "-x"},
			want: ttscadapter.Args{Subcommand: ttscadapter.SubcommandBuild, Cwd: "/p"},
		},
		{
			name: "subcommand after the flags",
			argv: []string{"--cwd", "/p", "version"},
			want: ttscadapter.Args{Subcommand: ttscadapter.SubcommandVersion, Cwd: "/p"},
		},
	}
}

func TestParseArgs(t *testing.T) {
	t.Parallel()
	for _, tt := range parseArgsCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := ttscadapter.ParseArgs(tt.argv)
			if err != nil {
				t.Fatalf("ParseArgs(%q) error = %v, want nil", tt.argv, err)
			}

			if got != tt.want {
				t.Errorf("ParseArgs(%q) = %+v, want %+v", tt.argv, got, tt.want)
			}
		})
	}
}

func TestParseArgs_RejectsUsageErrors(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		argv []string
	}{
		{name: "no arguments", argv: nil},
		{name: "only flags", argv: []string{"--cwd=/p", "--emit"}},
		{name: "unknown subcommand", argv: []string{"banana", "--cwd=/p"}},
		{name: "value flag without a value", argv: []string{"build", "--outDir"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, err := ttscadapter.ParseArgs(tt.argv)

			if !errors.Is(err, ttscadapter.ErrUsage) {
				t.Errorf("ParseArgs(%q) error = %v, want ErrUsage", tt.argv, err)
			}
		})
	}
}
