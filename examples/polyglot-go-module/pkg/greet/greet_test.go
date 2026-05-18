package greet

import "testing"

func TestHelloIncludesName(t *testing.T) {
	got := Hello("world")
	if got != "Hello, world!" {
		t.Fatalf("Hello(world) = %q, want %q", got, "Hello, world!")
	}
}
