package ttscadapter

import (
	"fmt"
	"path/filepath"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/emit"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
)

// analyzer analyzes one file of a loaded Program. It is the seam a test replaces to make one
// file's analysis panic. It takes the Program rather than its checker so that this package never
// imports the checker shim, which only analysis may.
type analyzer = func(*driver.Program, *ast.SourceFile, *analysis.PackageRoots) []facts.Site

// inliner emits one planned rewrite into the file it rewrites, as (*emit.File).Inline does. It is
// the seam a test replaces to make one site's emit panic.
type inliner = func(*emit.File, plan.EachInlining, []facts.ViewUse)

// physicalResolver resolves the physical path of a src/debug.ts already read, as
// filepath.EvalSymlinks does. It is the seam a test replaces to make that resolution fail, which
// otherwise takes the file being moved between its read and its resolution.
type physicalResolver = func(path string) (string, error)

// rewriter rewrites the files of one Program, loading the DEBUG gate of each package root once.
type rewriter struct {
	prog     *driver.Program
	roots    *analysis.PackageRoots
	debugs   map[string]debugLoad
	analyze  analyzer
	inline   inliner
	physical physicalResolver
}

// debugGate is the DEBUG gate of one package root, with the physical path its src/debug.ts was
// read through.
type debugGate struct {
	debug    *emit.Debug
	physical string
}

// debugLoad is the outcome of loading the DEBUG gate of one package root.
type debugLoad struct {
	err  error
	gate debugGate
}

// rewrittenFile is one file after analysis, plan, and emit.
type rewrittenFile struct {
	// output is the rewrite of the file, nil when no site was rewritten.
	output *emit.File
	// debug is the DEBUG gate output copies; its debug is nil when output is.
	debug debugGate
	// consulted lists the declaration files the shape resolution of its sites consulted, and the
	// src/debug.ts of debug.
	consulted []string
	bails     []plan.Bail
}

func (r pluginRun) newRewriter(prog *driver.Program) *rewriter {
	inline := r.inline
	if inline == nil {
		inline = (*emit.File).Inline
	}
	physical := r.physical
	if physical == nil {
		physical = filepath.EvalSymlinks
	}
	return &rewriter{
		prog: prog, roots: analysis.NewPackageRoots(), debugs: map[string]debugLoad{}, analyze: r.analyze, inline: inline,
		physical: physical,
	}
}

// rewrite analyzes file, plans its sites, and emits every planned rewrite through ctx, copying the
// DEBUG gate of the package root the first rewritten call resolved to.
//
// A rewrite whose call resolves to another package root, or whose emit panics, keeps its runtime
// call and becomes an INTERNAL bail; the file's other rewrites still apply. When that root's
// src/debug.ts cannot be read or declares no DEBUG with an initializer, every planned rewrite
// becomes an INTERNAL bail naming the failure, and the file is left unchanged.
func (w *rewriter) rewrite(ctx *printer.EmitContext, file *ast.SourceFile) rewrittenFile {
	sites, table, result, fileBail, ok := w.analyzeFile(file)
	if !ok {
		return rewrittenFile{bails: []plan.Bail{fileBail}}
	}
	out := rewrittenFile{bails: result.Bails, consulted: declarationFiles(sites, nil)}
	if len(result.Rewrites) == 0 {
		return out
	}
	byCall := map[facts.NodeID]*facts.Site{}
	indexSites(sites, byCall)
	root := byCall[result.Rewrites[0].Call].Root
	gate, err := w.debug(root)
	if err != nil {
		for _, rewrite := range result.Rewrites {
			out.bails = append(out.bails, rewriteBail(rewrite).Internal(err))
		}
		return out
	}
	f := emit.NewFile(ctx, file, table, gate.debug)
	inlined := false
	for _, rewrite := range result.Rewrites {
		site := byCall[rewrite.Call]
		if site.Root != root {
			out.bails = append(out.bails, rewriteBail(rewrite).Internal(fmt.Sprintf(
				"the call resolves to the ecstatic package root %s, not %s, which the file's DEBUG copy comes from", site.Root, root)))
			continue
		}
		if bail, failed := inlineSite(w.inline, f, rewrite, site.Callback.ViewUses); failed {
			out.bails = append(out.bails, bail)
			continue
		}
		inlined = true
	}
	if inlined {
		out.output = f
		out.debug = gate
		out.consulted = append(out.consulted, filepath.ToSlash(gate.debug.Path))
	}
	return out
}

// analyzeFile analyzes file and plans its sites, returning them with the node table their IDs
// index. A panic makes the whole file one INTERNAL bail, at its start, and ok false.
func (w *rewriter) analyzeFile(
	file *ast.SourceFile,
) (sites []facts.Site, table *nodes.Table, result plan.Result, fileBail plan.Bail, ok bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			fileStart := plan.Bail{Op: facts.OpNone, Pos: facts.Position{File: file.FileName(), Line: 1, Column: 1}}
			sites, table, result, fileBail, ok = nil, nil, plan.Result{}, fileStart.Internal(recovered), false
		}
	}()
	if w.analyze == nil {
		sites, table = analysis.Analyze(w.prog.Checker, file, w.roots)
	} else {
		sites = w.analyze(w.prog, file, w.roots)
		// A test's analyzer reports the sites of the real analysis, or panics; analysis registers
		// nodes in a fixed walk order, so the table of a second, real analysis indexes those sites.
		_, table = analysis.Analyze(w.prog.Checker, file, w.roots)
	}
	return sites, table, plan.Plan(sites), plan.Bail{}, true
}

// debug returns the DEBUG gate of the package root at root, loading it on first use. The error is
// emit.LoadDebug's, or names the src/debug.ts whose physical path cannot be resolved.
func (w *rewriter) debug(root string) (debugGate, error) {
	load, ok := w.debugs[root]
	if !ok {
		load = loadDebug(root, w.physical)
		w.debugs[root] = load
	}
	return load.gate, load.err
}

func loadDebug(root string, resolve physicalResolver) debugLoad {
	debug, err := emit.LoadDebug(root)
	if err != nil {
		return debugLoad{err: err}
	}
	physical, err := resolve(debug.Path)
	if err != nil {
		return debugLoad{err: fmt.Errorf("resolve %s: %w", debug.Path, err)}
	}
	return debugLoad{gate: debugGate{debug: debug, physical: physical}}
}

// inlineSite emits rewrite into file through inline, with uses the view uses of its callback. A
// panic leaves file as it was and is returned as the site's INTERNAL bail, with failed true.
func inlineSite(inline inliner, file *emit.File, rewrite plan.EachInlining, uses []facts.ViewUse) (bail plan.Bail, failed bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			bail, failed = rewriteBail(rewrite).Internal(recovered), true
		}
	}()
	inline(file, rewrite, uses)
	return plan.Bail{}, false
}

// rewriteBail is the bail of the each call rewrite would have inlined, with no reason yet.
func rewriteBail(rewrite plan.EachInlining) plan.Bail {
	return plan.Bail{Op: facts.OpEach, Pos: rewrite.Pos, Call: rewrite.Call}
}

// indexSites maps the call of every site in sites, nested sites included, to its site.
func indexSites(sites []facts.Site, byCall map[facts.NodeID]*facts.Site) {
	for i := range sites {
		byCall[sites[i].Call] = &sites[i]
		indexSites(sites[i].Nested, byCall)
	}
}

// declarationFiles appends to files the declaration files of sites and of their nested sites.
func declarationFiles(sites []facts.Site, files []string) []string {
	for _, site := range sites {
		files = append(files, site.DeclarationFiles...)
		files = declarationFiles(site.Nested, files)
	}
	return files
}
