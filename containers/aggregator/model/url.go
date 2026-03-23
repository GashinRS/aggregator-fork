package model

import "strings"

func PublicURL(path string) string {
	base := strings.TrimSuffix(ExternalBasePath, "/")
	relative := "/" + strings.TrimLeft(path, "/")
	return Protocol + "://" + ExternalHost + base + relative
}

func PublicBaseURL() string {
	base := strings.TrimSuffix(ExternalBasePath, "/")
	return Protocol + "://" + ExternalHost + base
}
