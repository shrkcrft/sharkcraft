package greet

import "testing"

func TestHello(t *testing.T) {
	if Hello("mixed") != "Hello, mixed!" {
		t.Fatal("unexpected greeting")
	}
}
