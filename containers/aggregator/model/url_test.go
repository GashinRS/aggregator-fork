package model

import "testing"

func TestPublicURLWithBasePath(t *testing.T) {
	originalProtocol := Protocol
	originalHost := ExternalHost
	originalBasePath := ExternalBasePath
	t.Cleanup(func() {
		Protocol = originalProtocol
		ExternalHost = originalHost
		ExternalBasePath = originalBasePath
	})

	Protocol = "https"
	ExternalHost = "example.com"
	ExternalBasePath = "/aggregator"

	got := PublicURL("/config/ns/services")
	want := "https://example.com/aggregator/config/ns/services"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestPublicBaseURL(t *testing.T) {
	originalProtocol := Protocol
	originalHost := ExternalHost
	originalBasePath := ExternalBasePath
	t.Cleanup(func() {
		Protocol = originalProtocol
		ExternalHost = originalHost
		ExternalBasePath = originalBasePath
	})

	Protocol = "https"
	ExternalHost = "example.com"
	ExternalBasePath = "/aggregator/"

	got := PublicBaseURL()
	want := "https://example.com/aggregator"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}
