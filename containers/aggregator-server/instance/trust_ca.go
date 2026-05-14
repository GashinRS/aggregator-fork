package instance

import (
	"os"
	"path/filepath"

	corev1 "k8s.io/api/core/v1"
)

const trustCAVolumeName = "trust-ca"

func trustCAConfigMapName() string {
	return os.Getenv("TRUST_CA_CONFIGMAP_NAME")
}

func trustCAMountPath() string {
	if mountPath := os.Getenv("TRUST_CA_MOUNT_PATH"); mountPath != "" {
		return mountPath
	}
	return "/etc/ssl/pacsoi-ca"
}

func trustCACertKey() string {
	if key := os.Getenv("TRUST_CA_CERT_KEY"); key != "" {
		return key
	}
	return "ca.crt"
}

func trustCACertFile() string {
	if certFile := os.Getenv("SSL_CERT_FILE"); certFile != "" {
		return certFile
	}
	return filepath.Join(trustCAMountPath(), trustCACertKey())
}

func trustCAEnvVars(includePropagationConfig bool) []corev1.EnvVar {
	if trustCAConfigMapName() == "" {
		return nil
	}

	env := []corev1.EnvVar{
		{Name: "SSL_CERT_FILE", Value: trustCACertFile()},
		{Name: "NODE_EXTRA_CA_CERTS", Value: trustCACertFile()},
	}
	if includePropagationConfig {
		env = append(env,
			corev1.EnvVar{Name: "TRUST_CA_CONFIGMAP_NAME", Value: trustCAConfigMapName()},
			corev1.EnvVar{Name: "TRUST_CA_MOUNT_PATH", Value: trustCAMountPath()},
			corev1.EnvVar{Name: "TRUST_CA_CERT_KEY", Value: trustCACertKey()},
		)
	}
	return env
}

func trustCAVolumeMounts() []corev1.VolumeMount {
	if trustCAConfigMapName() == "" {
		return nil
	}
	return []corev1.VolumeMount{
		{
			Name:      trustCAVolumeName,
			MountPath: trustCAMountPath(),
			ReadOnly:  true,
		},
	}
}

func trustCAVolumes() []corev1.Volume {
	if trustCAConfigMapName() == "" {
		return nil
	}
	return []corev1.Volume{
		{
			Name: trustCAVolumeName,
			VolumeSource: corev1.VolumeSource{
				ConfigMap: &corev1.ConfigMapVolumeSource{
					LocalObjectReference: corev1.LocalObjectReference{
						Name: trustCAConfigMapName(),
					},
				},
			},
		},
	}
}
