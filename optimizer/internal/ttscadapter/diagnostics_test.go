package ttscadapter_test

import (
	"bytes"
	"errors"
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
)

// strictMode ends the message of a bail that strict reports.
const strictMode = " (strict mode)"

// callMessage is the message of a bail of the op call whose reason reads text, with suffix after the runtime-call
// sentence and hint last.
func callMessage(op, text, suffix, hint string) string {
	return withHint("ecstatic: The "+op+"() call cannot be optimized ("+text+"). It compiles to the runtime call"+
		suffix+".", hint)
}

// withHint is message followed by hint, when there is one.
func withHint(message, hint string) string {
	if hint == "" {
		return message
	}
	return message + " " + hint
}

// reasonReport is the report of a bail of the op call for reason, with the reason's catalog text, hint, and code.
func reasonReport(category, op string, reason facts.Reason) report {
	info := reason.Info()
	suffix := ""
	if category == categoryError {
		suffix = strictMode
	}
	return report{category: category, code: info.Code, message: callMessage(op, info.Text, suffix, info.Hint)}
}

// internalText is the INTERNAL reason's text for detail.
func internalText(detail string) string {
	return "internal error (`" + detail + "`); please report it"
}

func at(file string, offset, line, column int) facts.Position {
	return facts.Position{File: file, Offset: offset, Line: line, Column: column}
}

// report is what a diagnostic says: its category, code, and message.
type report struct {
	category string
	message  string
	code     int
}

// diagnosticAt is the diagnostic a call at pos reports with r.
func diagnosticAt(pos facts.Position, r report) ttscadapter.Diagnostic {
	return ttscadapter.Diagnostic{
		File: pos.File, Category: r.category, Code: r.code, Start: pos.Offset, Line: pos.Line, Character: pos.Column,
		MessageText: r.message,
	}
}

// asyncStrictReport is the strict report of a CALLBACK_ASYNC bail.
func asyncStrictReport() report {
	return reasonReport(categoryError, "each", facts.ReasonCallbackAsync)
}

// asyncWarningReport is the non-strict report of a CALLBACK_ASYNC bail.
func asyncWarningReport() report {
	return reasonReport(categoryWarning, "each", facts.ReasonCallbackAsync)
}

// internalDetail is the detail of the internal bails the tests report.
const internalDetail = "nil storage"

func bailAt(op facts.Op, reason facts.Reason, pos facts.Position) plan.Bail {
	return plan.Bail{Op: op, Reason: reason, Pos: pos}
}

// internalReport is the strict report of a call-level INTERNAL bail with internalDetail.
func internalReport() report {
	info := facts.ReasonInternal.Info()
	return report{
		category: categoryError, code: info.Code,
		message: callMessage("each", internalText(internalDetail), strictMode, info.Hint),
	}
}

// internalBailAt is the internal bail of an each call at pos, with internalDetail.
func internalBailAt(pos facts.Position) plan.Bail {
	internal := bailAt(facts.OpEach, facts.ReasonInternal, pos)
	internal.Detail = internalDetail
	return internal
}

func TestBailDiagnostics(t *testing.T) {
	t.Parallel()
	shape := at("main.ts", 14, 3, 5)
	storages := at("main.ts", 41, 5, 9)
	async := at("main.ts", 68, 7, 13)
	internalPos := at("main.ts", 117, 11, 4)
	bails := []plan.Bail{
		bailAt(facts.OpEach, facts.ReasonShapeUnresolved, shape),
		bailAt(facts.OpQuery, facts.ReasonStoragesDynamic, storages),
		bailAt(facts.OpEach, facts.ReasonCallbackAsync, async),
		bailAt(facts.OpHas, facts.ReasonNotStatement, at("main.ts", 90, 9, 3)),
		internalBailAt(internalPos),
	}
	tests := []struct {
		name       string
		wantStderr string
		want       []ttscadapter.Diagnostic
		opts       ttscadapter.Options
	}{
		{
			name: "strict reports strict, warning, and internal bails as errors",
			opts: ttscadapter.Options{Strict: true},
			want: []ttscadapter.Diagnostic{
				diagnosticAt(shape, reasonReport(categoryError, "each", facts.ReasonShapeUnresolved)),
				diagnosticAt(storages, reasonReport(categoryError, "query", facts.ReasonStoragesDynamic)),
				diagnosticAt(async, asyncStrictReport()),
				diagnosticAt(internalPos, internalReport()),
			},
		},
		{
			name:       "without strict only the warning bail is reported, and the internal bail goes to stderr",
			opts:       ttscadapter.Options{Strict: false},
			want:       []ttscadapter.Diagnostic{diagnosticAt(async, asyncWarningReport())},
			wantStderr: "main.ts:11:4: " + callMessage("each", internalText(internalDetail), "", "") + "\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var stderr bytes.Buffer

			got, err := ttscadapter.BailDiagnostics(bails, tt.opts, &stderr)
			if err != nil {
				t.Fatalf("BailDiagnostics(%+v) error = %v, want nil", tt.opts, err)
			}

			if diff := cmp.Diff(tt.want, got); diff != "" {
				t.Errorf("BailDiagnostics(%+v) mismatch (-want +got):\n%s", tt.opts, diff)
			}
			if stderr.String() != tt.wantStderr {
				t.Errorf("BailDiagnostics(%+v) stderr = %q, want %q", tt.opts, stderr.String(), tt.wantStderr)
			}
		})
	}
}

func TestBailDiagnostics_WhenStderrFails_ReturnsTheWriteError(t *testing.T) {
	t.Parallel()
	internal := internalBailAt(at("main.ts", 47, 4, 11))

	_, err := ttscadapter.BailDiagnostics([]plan.Bail{internal}, ttscadapter.Options{}, failingWriter{})

	if !errors.Is(err, errWrite) {
		t.Errorf("BailDiagnostics() error = %v, want %v", err, errWrite)
	}
}

func TestBailDiagnostics_WhenBailsAreOutOfOrder_OrdersByFileThenPosition(t *testing.T) {
	t.Parallel()
	aFirstLine := at("a.ts", 12, 1, 13)
	aThirdLine := at("a.ts", 40, 3, 5)
	bLineStart := at("b.ts", 25, 2, 4)
	bLineEnd := at("b.ts", 30, 2, 9)
	bails := []plan.Bail{
		bailAt(facts.OpEach, facts.ReasonCallbackAsync, bLineEnd),
		bailAt(facts.OpEach, facts.ReasonCallbackAsync, aThirdLine),
		bailAt(facts.OpEach, facts.ReasonCallbackAsync, bLineStart),
		bailAt(facts.OpEach, facts.ReasonCallbackAsync, aFirstLine),
	}
	want := []ttscadapter.Diagnostic{
		diagnosticAt(aFirstLine, asyncWarningReport()),
		diagnosticAt(aThirdLine, asyncWarningReport()),
		diagnosticAt(bLineStart, asyncWarningReport()),
		diagnosticAt(bLineEnd, asyncWarningReport()),
	}

	got, err := ttscadapter.BailDiagnostics(bails, ttscadapter.Options{}, &bytes.Buffer{})
	if err != nil {
		t.Fatalf("BailDiagnostics() error = %v, want nil", err)
	}

	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("BailDiagnostics() mismatch (-want +got):\n%s", diff)
	}
}

func TestDiagnostic_WhenMarshaled_EncodesTtscFieldNames(t *testing.T) {
	t.Parallel()
	diagnostic := diagnosticAt(at("/p/main.ts", 57, 3, 12), report{category: categoryWarning, code: 99915, message: "ecstatic: banana"})
	want := map[string]any{
		"file": "/p/main.ts", "category": "warning", "code": 99915.0, "start": 57.0, "line": 3.0,
		"character": 12.0, "messageText": "ecstatic: banana",
	}

	got := decodedJSON(t, diagnostic)

	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("json.Marshal(%+v) fields mismatch (-want +got):\n%s", diagnostic, diff)
	}
}
