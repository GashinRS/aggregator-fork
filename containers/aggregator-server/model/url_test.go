package model

import "testing"

func TestPublicURL(t *testing.T) {
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

	got := PublicURL("/registration")
	want := "https://example.com/aggregator/registration"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestPublicURLNoBasePath(t *testing.T) {
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
	ExternalBasePath = ""

	got := PublicURL("registration")
	want := "https://example.com/registration"
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
