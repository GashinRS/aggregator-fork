package model

type User struct {
	UserId         string
	AccessToken    string
	RefreshToken   string
	AuthzServerURL string
	Namespace      string
	UseProxy       bool
}

func (u *User) ConfigEndpoints() map[string]string {
	return map[string]string{
		"services": PublicURL("/config/" + u.Namespace + "/services"),
	}
}
