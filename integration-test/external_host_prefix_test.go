package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"aggregator-integration-test/mocks"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestExternalHostPathPrefix_MetadataAndRegistrationURLs(t *testing.T) {
	const prefixedExternalHost = "http://aggregator.local:5000/east-coast/aggregator"
	const cfgNamespace = "aggregator-app"
	const cfgName = "aggregator-config"

	originalExternalHost := updateExternalHostAndRestartAggregatorServer(t, prefixedExternalHost, cfgNamespace, cfgName)
	t.Cleanup(func() {
		updateExternalHostAndRestartAggregatorServer(t, originalExternalHost, cfgNamespace, cfgName)
	})

	descResp, err := http.Get(testEnv.AggregatorURL + "/")
	if err != nil {
		t.Fatalf("Failed to fetch server description: %v", err)
	}
	defer descResp.Body.Close()

	if descResp.StatusCode != http.StatusOK {
		t.Fatalf("Expected server description 200, got %d", descResp.StatusCode)
	}

	var desc map[string]interface{}
	if err := json.NewDecoder(descResp.Body).Decode(&desc); err != nil {
		t.Fatalf("Failed to decode server description: %v", err)
	}

	expectServerURL(t, desc, "registration_endpoint", prefixedExternalHost+"/registration")
	expectServerURL(t, desc, "client_identifier", prefixedExternalHost+"/client.json")
	expectServerURL(t, desc, "transformation_catalog", prefixedExternalHost+"/config/transformations")

	oidcProvider, err := mocks.NewOIDCProvider()
	if err != nil {
		t.Fatalf("Failed to create OIDC provider: %v", err)
	}
	defer oidcProvider.Close()

	ownerWebID := oidcProvider.URL() + "/webid#me"
	authToken := createAuthToken(t, oidcProvider, ownerWebID)

	body, _ := json.Marshal(map[string]string{"registration_type": "none"})
	req, err := http.NewRequest(http.MethodPost, testEnv.AggregatorURL+"/registration", bytes.NewBuffer(body))
	if err != nil {
		t.Fatalf("Failed to create registration request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+authToken)

	regResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Registration request failed: %v", err)
	}
	defer regResp.Body.Close()

	if regResp.StatusCode != http.StatusCreated {
		t.Fatalf("Expected registration status 201, got %d", regResp.StatusCode)
	}

	var reg map[string]interface{}
	if err := json.NewDecoder(regResp.Body).Decode(&reg); err != nil {
		t.Fatalf("Failed to decode registration response: %v", err)
	}

	aggregatorID, _ := reg["aggregator_id"].(string)
	if aggregatorID == "" {
		t.Fatal("Registration response missing aggregator_id")
	}
	t.Cleanup(func() {
		deleteAggregator(t, aggregatorID, authToken)
	})

	aggregatorURL, _ := reg["aggregator"].(string)
	if !strings.HasPrefix(aggregatorURL, prefixedExternalHost+"/config/") {
		t.Fatalf("Expected aggregator URL with prefixed external host, got %q", aggregatorURL)
	}

	namespace := waitForAggregatorNamespace(t, ownerWebID)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	waitForDeploymentReady(t, ctx, namespace, "aggregator")

	deployment, err := testEnv.KubeClient.AppsV1().Deployments(namespace).Get(ctx, "aggregator", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("Failed to fetch aggregator deployment: %v", err)
	}

	var actualExternalHost string
	for _, envVar := range deployment.Spec.Template.Spec.Containers[0].Env {
		if envVar.Name == "AGGREGATOR_EXTERNAL_HOST" {
			actualExternalHost = strings.TrimSpace(envVar.Value)
			break
		}
	}
	if actualExternalHost != prefixedExternalHost {
		t.Fatalf("Expected AGGREGATOR_EXTERNAL_HOST=%q, got %q", prefixedExternalHost, actualExternalHost)
	}
}

func expectServerURL(t *testing.T, desc map[string]interface{}, field string, want string) {
	t.Helper()

	got, ok := desc[field].(string)
	if !ok {
		t.Fatalf("Server description field %q missing or not a string", field)
	}
	if got != want {
		t.Fatalf("Unexpected %s: want %q, got %q", field, want, got)
	}
}

func updateExternalHostAndRestartAggregatorServer(t *testing.T, externalHost string, namespace string, configMapName string) string {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	configMap, err := testEnv.KubeClient.CoreV1().ConfigMaps(namespace).Get(ctx, configMapName, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("Failed to read ConfigMap %s/%s: %v", namespace, configMapName, err)
	}

	if configMap.Data == nil {
		configMap.Data = map[string]string{}
	}
	previousExternalHost := strings.TrimSpace(configMap.Data["external_host"])
	configMap.Data["external_host"] = externalHost
	if _, err := testEnv.KubeClient.CoreV1().ConfigMaps(namespace).Update(ctx, configMap, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("Failed to update ConfigMap %s/%s: %v", namespace, configMapName, err)
	}

	deployment, err := testEnv.KubeClient.AppsV1().Deployments(namespace).Get(ctx, "aggregator-server", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("Failed to get aggregator-server deployment: %v", err)
	}

	if deployment.Spec.Template.Annotations == nil {
		deployment.Spec.Template.Annotations = map[string]string{}
	}
	deployment.Spec.Template.Annotations["integration-test/restarted-at"] = time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := testEnv.KubeClient.AppsV1().Deployments(namespace).Update(ctx, deployment, metav1.UpdateOptions{}); err != nil {
		t.Fatalf("Failed to restart aggregator-server deployment: %v", err)
	}

	waitForDeploymentReady(t, ctx, namespace, "aggregator-server")
	waitForAggregatorReady(t, ctx, strings.TrimRight(testEnv.AggregatorURL, "/")+"/")

	return previousExternalHost
}
