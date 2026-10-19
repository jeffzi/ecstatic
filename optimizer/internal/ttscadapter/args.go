package ttscadapter

import (
	"errors"
	"fmt"
	"slices"
	"strings"
)

// errUsage marks an invocation the sidecar cannot run: a bad subcommand, a flag missing its
// value, or invalid plugin options. The command exits 2 on it.
var errUsage = errors.New("usage error")

// subcommandName is the verb ttsc runs the sidecar with.
type subcommandName string

const (
	subcommandTransform subcommandName = "transform"
	subcommandCheck     subcommandName = "check"
	subcommandBuild     subcommandName = "build"
	subcommandVersion   subcommandName = "version" // ttsc never spawns it; it is a smoke test.
)

type subcommandUsage struct {
	subcommand subcommandName
	summary    string
}

// subcommandUsages returns the accepted subcommands, in the order usage errors and the usage text
// list them.
func subcommandUsages() []subcommandUsage {
	return []subcommandUsage{
		{subcommand: subcommandTransform, summary: "write the transformed project to stdout"},
		{subcommand: subcommandCheck, summary: "type-check the project and report its diagnostics"},
		{subcommand: subcommandBuild, summary: "type-check the project and emit it"},
		{subcommand: subcommandVersion, summary: "print the plugin version"},
	}
}

// subcommands returns the accepted subcommands, in the order usage errors list them.
func subcommands() []subcommandName {
	usages := subcommandUsages()
	subs := make([]subcommandName, 0, len(usages))
	for _, u := range usages {
		subs = append(subs, u.subcommand)
	}
	return subs
}

func subcommandList() string {
	subs := subcommands()
	names := make([]string, 0, len(subs))
	for _, sub := range subs {
		names = append(names, string(sub))
	}
	return strings.Join(names, ", ")
}

// sidecarArgs is a parsed sidecar invocation. A flag ttsc did not pass keeps its zero value.
type sidecarArgs struct {
	Subcommand  subcommandName
	Cwd         string
	Tsconfig    string
	PluginsJSON string
	OutDir      string
	Emit        bool
}

// parseArgs parses argv, the arguments after the program name.
//
// The subcommand is the first positional argument. Value flags (--cwd, --tsconfig, --plugins-json,
// --outDir) accept both --flag=value, the form ttsc passes, and --flag value. Every other flag and
// positional argument is ignored, because ttsc adds capability-gated flags this plugin does not
// use. The error wraps errUsage when the subcommand is missing or unknown, or when a value flag
// ends argv without its value.
func parseArgs(argv []string) (sidecarArgs, error) {
	var args sidecarArgs
	var positional []string
	for i := 0; i < len(argv); i++ {
		name, value, hasValue := strings.Cut(argv[i], "=")
		target := args.valueFlag(name)
		switch {
		case target != nil && hasValue:
			*target = value
		case target != nil && i+1 == len(argv):
			return sidecarArgs{}, fmt.Errorf("%w: flag %s needs a value", errUsage, name)
		case target != nil:
			i++
			*target = argv[i]
		case !strings.HasPrefix(argv[i], "-"):
			positional = append(positional, argv[i])
		default:
			args.setSwitch(argv[i])
		}
	}
	if len(positional) == 0 {
		return sidecarArgs{}, fmt.Errorf("%w: missing subcommand; want one of %s", errUsage, subcommandList())
	}
	args.Subcommand = subcommandName(positional[0])
	if !slices.Contains(subcommands(), args.Subcommand) {
		return sidecarArgs{}, fmt.Errorf("%w: unknown subcommand %q; want one of %s", errUsage, args.Subcommand, subcommandList())
	}
	return args, nil
}

// cliFlag is one flag the sidecar reads and its entry in the usage text. A value flag sets the field
// value returns and shows placeholder as its value in the usage text; a switch sets the field on
// returns.
type cliFlag struct {
	value       func(*sidecarArgs) *string
	on          func(*sidecarArgs) *bool
	name        string
	placeholder string
	summary     string
}

// cliFlags returns every flag the sidecar reads, in the order the usage text lists them.
func cliFlags() []cliFlag {
	return []cliFlag{
		{
			name:        "--cwd",
			placeholder: "<dir>",
			value:       func(a *sidecarArgs) *string { return &a.Cwd },
			summary:     "the project root",
		},
		{
			name:        "--tsconfig",
			placeholder: "<path>",
			value:       func(a *sidecarArgs) *string { return &a.Tsconfig },
			summary:     "the project's tsconfig, relative to --cwd",
		},
		{
			name:        "--plugins-json",
			placeholder: "<json>",
			value:       func(a *sidecarArgs) *string { return &a.PluginsJSON },
			summary:     "the compilerOptions.plugins entries ttsc passes",
		},
		{
			name:        "--outDir",
			placeholder: "<dir>",
			value:       func(a *sidecarArgs) *string { return &a.OutDir },
			summary:     "build: the output directory",
		},
		{
			name:    "--emit",
			on:      func(a *sidecarArgs) *bool { return &a.Emit },
			summary: "build: emit even when the tsconfig sets noEmit",
		},
	}
}

func lookupFlag(name string) (cliFlag, bool) {
	flags := cliFlags()
	if i := slices.IndexFunc(flags, func(f cliFlag) bool { return f.name == name }); i >= 0 {
		return flags[i], true
	}
	return cliFlag{}, false
}

func (a *sidecarArgs) valueFlag(name string) *string {
	if f, ok := lookupFlag(name); ok && f.value != nil {
		return f.value(a)
	}
	return nil
}

func (a *sidecarArgs) setSwitch(arg string) {
	if f, ok := lookupFlag(arg); ok && f.on != nil {
		*f.on(a) = true
	}
}
