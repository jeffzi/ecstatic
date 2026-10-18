package nodes_test

import (
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/microsoft/typescript-go/shim/ast"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
)

// identifiers builds count distinct identifier nodes.
func identifiers(count int) []*ast.Node {
	factory := ast.NewNodeFactory(ast.NodeFactoryHooks{})
	out := make([]*ast.Node, count)
	for i := range out {
		out[i] = factory.NewIdentifier("banana")
	}
	return out
}

func TestTable_Register_WhenNodeRepeats_ReusesItsIDWithoutConsumingOne(t *testing.T) {
	t.Parallel()
	table := nodes.NewTable()
	nodeList := identifiers(3)
	sequence := []int{0, 1, 0, 2}
	want := []facts.NodeID{0, 1, 0, 2}

	got := make([]facts.NodeID, 0, len(sequence))
	for _, i := range sequence {
		got = append(got, table.Register(nodeList[i]))
	}

	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Register() IDs mismatch (-want +got):\n%s", diff)
	}
}

func TestTable_Node_WhenIDRegistered_ReturnsItsNode(t *testing.T) {
	t.Parallel()
	table := nodes.NewTable()
	nodeList := identifiers(2)
	table.Register(nodeList[0])
	id := table.Register(nodeList[1])

	got, ok := table.Node(id)

	if !ok || got != nodeList[1] {
		t.Errorf("Node(%d) = %p, %t, want %p, true", id, got, ok, nodeList[1])
	}
}

func TestTable_Node_ReportsUnknownIDsAsNotFound(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		id   facts.NodeID
	}{
		{name: "negative", id: -1},
		{name: "one past the last registered", id: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			table := nodes.NewTable()
			table.Register(identifiers(1)[0])

			got, ok := table.Node(tt.id)

			if ok {
				t.Errorf("Node(%d) = %p, true, want not found", tt.id, got)
			}
		})
	}
}
