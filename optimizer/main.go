// Ecstatic-optimizer is the ttsc sidecar that compiles ecstatic's query calls into inline loops.
package main

import (
	"os"

	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
)

func main() {
	os.Exit(ttscadapter.Run(os.Args[1:], os.Stdout, os.Stderr))
}
