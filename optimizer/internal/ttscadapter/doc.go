// Package ttscadapter speaks the ttsc sidecar protocol: Run is the sidecar's entry point; the
// package reads the argv and plugin options ttsc passes, loads the project's Program through ttsc's
// driver, and reports call-site bails as diagnostics in ttsc's public shape.
package ttscadapter
