package emit

import "github.com/jeffzi/ecstatic/optimizer/internal/plan"

// SetBeforeCommit makes Inline call hook with each inlining of f once its loop is built, before f records the loop, so
// a test can make Inline panic after building it. A nil hook removes it.
func (f *File) SetBeforeCommit(hook func(plan.EachInlining)) {
	f.beforeCommit = hook
}
