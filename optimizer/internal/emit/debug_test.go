package emit_test

import (
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jeffzi/ecstatic/optimizer/internal/emit"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
)

func TestLoadDebug_WhenDebugTsHasNoInitializerToCopy_ReturnsError(t *testing.T) {
	t.Parallel()
	tests := []struct {
		want  error
		files map[string]string
		name  string
	}{
		{name: "no src/debug.ts", files: map[string]string{"src/index.ts": "export {};\n"}, want: fs.ErrNotExist},
		{name: "no DEBUG declared", files: map[string]string{"src/debug.ts": "export const CHECKS = true;\n"}, want: emit.ErrNoDebug},
		{
			name:  "DEBUG declared without an initializer",
			files: map[string]string{"src/debug.ts": "export declare const DEBUG: boolean;\n"},
			want:  emit.ErrNoDebug,
		},
		{
			name:  "DEBUG declared only inside a function",
			files: map[string]string{"src/debug.ts": "export function checks(): boolean {\n    const DEBUG = true;\n    return DEBUG;\n}\n"},
			want:  emit.ErrNoDebug,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			root := project.Write(t, tt.files)
			path := filepath.Join(root, "src", "debug.ts")

			_, err := emit.LoadDebug(root)

			if !errors.Is(err, tt.want) {
				t.Errorf("LoadDebug(%s) error = %v, want %v", root, err, tt.want)
			}
			if err != nil && !strings.Contains(err.Error(), path) {
				t.Errorf("LoadDebug(%s) error = %q, want it to name %s", root, err, path)
			}
		})
	}
}
