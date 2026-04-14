package services

import (
	"aggregator/model"
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/maartyman/rdfgo"
	"github.com/sirupsen/logrus"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// SourceUpdateMode defines how sources should be updated
type SourceUpdateMode string

const (
	SourceModeOverwrite SourceUpdateMode = "overwrite"
	SourceModeAdd       SourceUpdateMode = "add"
	SourceModeRemove    SourceUpdateMode = "remove"
)

// UpdateServiceSources updates the SOURCES parameter of a running service.
// It updates both the in-memory service model and the Kubernetes Deployment.
func UpdateServiceSources(service *model.Service, newSources []string, mode SourceUpdateMode) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Find the sources parameter key in the service's params
	sourcesParamKey := ""
	for paramKey := range service.Exe.Params {
		pred, err := StripPrefix(paramKey, model.ExternalServerURL()+model.TransformationCatalog+"#")
		if err != nil {
			continue
		}
		envKey, exists := service.Exe.Transformation.InputMapping[pred]
		if exists && envKey == "SOURCES" {
			sourcesParamKey = paramKey
			break
		}
	}

	if sourcesParamKey == "" {
		return fmt.Errorf("service does not have a SOURCES parameter")
	}

	// Get the current sources
	currentSourcesStr := strings.Trim(service.Exe.Params[sourcesParamKey].GetValue(), "<>")
	currentSources := strings.Split(currentSourcesStr, ",")

	// Compute the new sources based on the mode
	var updatedSources []string
	switch mode {
	case SourceModeOverwrite:
		updatedSources = newSources
	case SourceModeAdd:
		existing := make(map[string]struct{})
		for _, s := range currentSources {
			trimmed := strings.TrimSpace(s)
			if trimmed != "" {
				existing[trimmed] = struct{}{}
				updatedSources = append(updatedSources, trimmed)
			}
		}
		for _, s := range newSources {
			trimmed := strings.TrimSpace(s)
			if trimmed != "" {
				if _, exists := existing[trimmed]; !exists {
					updatedSources = append(updatedSources, trimmed)
				}
			}
		}
	case SourceModeRemove:
		toRemove := make(map[string]struct{})
		for _, s := range newSources {
			trimmed := strings.TrimSpace(s)
			if trimmed != "" {
				toRemove[trimmed] = struct{}{}
			}
		}
		for _, s := range currentSources {
			trimmed := strings.TrimSpace(s)
			if trimmed != "" {
				if _, exists := toRemove[trimmed]; !exists {
					updatedSources = append(updatedSources, trimmed)
				}
			}
		}
	default:
		return fmt.Errorf("unknown source update mode: %s", mode)
	}

	if len(updatedSources) == 0 {
		return fmt.Errorf("cannot update sources: resulting source list would be empty")
	}

	updatedSourcesStr := strings.Join(updatedSources, ",")

	logrus.WithFields(logrus.Fields{
		"service_id":  service.InstanceID,
		"mode":        mode,
		"old_sources": currentSourcesStr,
		"new_sources": updatedSourcesStr,
	}).Info("Updating service sources")

	// Update the in-memory model
	service.Exe.Params[sourcesParamKey] = rdfgo.NewLiteral(updatedSourcesStr, "", nil)

	// Update the Kubernetes Deployment
	deploymentName := service.NamespaceID
	deployment, err := model.Clientset.AppsV1().Deployments(model.Namespace).Get(ctx, deploymentName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("failed to get deployment %s: %w", deploymentName, err)
	}

	// Find and update the SOURCES env var in the container spec
	updated := false
	for i := range deployment.Spec.Template.Spec.Containers {
		container := &deployment.Spec.Template.Spec.Containers[i]
		for j := range container.Env {
			if container.Env[j].Name == "SOURCES" {
				container.Env[j].Value = updatedSourcesStr
				updated = true
				break
			}
		}
		if updated {
			break
		}
	}

	if !updated {
		return fmt.Errorf("SOURCES environment variable not found in deployment %s", deploymentName)
	}

	// Apply the update — changing the pod template triggers a rolling restart
	_, err = model.Clientset.AppsV1().Deployments(model.Namespace).Update(ctx, deployment, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update deployment %s: %w", deploymentName, err)
	}

	logrus.WithFields(logrus.Fields{
		"service_id": service.InstanceID,
		"sources":    updatedSourcesStr,
	}).Info("Service sources updated successfully")

	return nil
}
