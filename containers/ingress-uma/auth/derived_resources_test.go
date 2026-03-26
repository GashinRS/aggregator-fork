package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestDerivedResourceIDs_ServiceLocation(t *testing.T) {
	originalHost := ExternalHost
	originalScheme := ExternalScheme
	ExternalHost = "aggregator.local:5000"
	ExternalScheme = "http"
	t.Cleanup(func() {
		ExternalHost = originalHost
		ExternalScheme = originalScheme
	})

	ids := derivedResourceIDs("/services/ns-123/svc-456")
	expected := []string{
		"http://aggregator.local:5000/services/ns-123/svc-456",
		"http://aggregator.local:5000/config/ns-123",
		"http://aggregator.local:5000/config/ns-123/services",
		"http://aggregator.local:5000/config/ns-123/transformations",
		"http://aggregator.local:5000/config/ns-123/services/svc-456",
	}

	assertStringSetEqual(t, ids, expected)
}

func TestDeriveOwnerWebID(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{
			input:    "http://rs.local:3000/alice/profile/card#me",
			expected: "http://rs.local:3000/alice/profile/card#me",
		},
		{
			input:    "http://rs.local:3000/alice/profile/card",
			expected: "http://rs.local:3000/alice/profile/card#me",
		},
		{
			input:    "http://rs.local:3000/alice",
			expected: "http://rs.local:3000/alice/profile/card#me",
		},
	}

	for _, test := range tests {
		if got := deriveOwnerWebID(test.input); got != test.expected {
			t.Fatalf("expected %q for %q, got %q", test.expected, test.input, got)
		}
	}
}

func TestDeriveOwnerWebID_ProbeNestedCandidatePaths(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/css1/alice/profile/card" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<> solid:oidcIssuer <https://idp.example> .
`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	sourceURL := server.URL + "/css1/alice/private/data/text.txt"
	expected := server.URL + "/css1/alice/profile/card#me"

	if got := deriveOwnerWebID(sourceURL); got != expected {
		t.Fatalf("expected %q, got %q", expected, got)
	}
}

func TestCandidateOwnerWebIDs_FilePath(t *testing.T) {
	parsed, err := url.Parse("http://example.org/css1/alice/private/data/text.txt")
	if err != nil {
		t.Fatalf("failed to parse URL: %v", err)
	}

	got := candidateOwnerWebIDs(parsed)
	expected := []string{
		"http://example.org/profile/card#me",
		"http://example.org/css1/profile/card#me",
		"http://example.org/css1/alice/profile/card#me",
		"http://example.org/css1/alice/private/profile/card#me",
		"http://example.org/css1/alice/private/data/profile/card#me",
	}

	assertStringSetEqual(t, got, expected)
}

func TestProbeProfileCard_RequiresOIDCIssuerPredicate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("@prefix foaf: <http://xmlns.com/foaf/0.1/> ."))
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if probeProfileCard(ctx, server.URL+"/profile/card#me") {
		t.Fatal("expected probe to fail when solid:oidcIssuer is missing")
	}
}

func assertStringSetEqual(t *testing.T, got []string, expected []string) {
	t.Helper()
	if len(got) != len(expected) {
		t.Fatalf("expected %d entries, got %d", len(expected), len(got))
	}

	seen := make(map[string]struct{}, len(got))
	for _, entry := range got {
		seen[entry] = struct{}{}
	}

	for _, entry := range expected {
		if _, ok := seen[entry]; !ok {
			t.Fatalf("expected %q in set, got %v", entry, got)
		}
	}
}
