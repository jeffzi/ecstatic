// Package nodes maps the NodeIDs analysis reports back to AST nodes, so
// plan refers to nodes by ID. It never depends on the checker.
package nodes

import (
	"github.com/microsoft/typescript-go/shim/ast"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
)

// Table assigns NodeIDs to the nodes of one source file. The zero Table is
// not usable; build one with NewTable.
type Table struct {
	ids   map[*ast.Node]facts.NodeID
	nodes []*ast.Node
}

// NewTable returns an empty table.
func NewTable() *Table {
	return &Table{ids: map[*ast.Node]facts.NodeID{}}
}

// Register returns node's ID, assigning the next one, dense from 0 in
// registration order, when node is new to the table.
func (t *Table) Register(node *ast.Node) facts.NodeID {
	if id, ok := t.ids[node]; ok {
		return id
	}
	id := facts.NodeID(len(t.nodes)) //nolint:gosec // a source file never holds 2^31 nodes, so the length fits in int32
	t.ids[node] = id
	t.nodes = append(t.nodes, node)
	return id
}

// Node returns the node registered under id, and false when no node has it.
func (t *Table) Node(id facts.NodeID) (*ast.Node, bool) {
	if id < 0 || int(id) >= len(t.nodes) {
		return nil, false
	}
	return t.nodes[id], true
}
