package server

import (
	"context"
	"net/http"

	intraoapi42 "github.com/42paris/intraoapi42"
)

// invoker adapts the dynamic browser request to one generated client method.
//
// Every entry goes through the typed `...Params` structs, so the intraoapi42
// client keeps building the URL, adding the OAuth2 token and retrying on 429 /
// 5xx exactly as it would in a normal Go program. Only the operations listed
// here can be reached through the UI: the server is a fixed allow-list, never a
// generic proxy.
type invoker func(ctx context.Context, client intraoapi42.ClientInterface, call *callRequest) (*http.Response, error)

var registry = map[string]invoker{
	"getCloses": func(ctx context.Context, client intraoapi42.ClientInterface, call *callRequest) (*http.Response, error) {
		var params intraoapi42.GetClosesParams
		if err := call.decodeQuery(&params); err != nil {
			return nil, err
		}
		return client.GetCloses(ctx, &params)
	},

	"getCloseById": func(ctx context.Context, client intraoapi42.ClientInterface, call *callRequest) (*http.Response, error) {
		id, err := call.pathInt("id")
		if err != nil {
			return nil, err
		}
		return client.GetCloseById(ctx, id)
	},

	"getInternships": func(ctx context.Context, client intraoapi42.ClientInterface, call *callRequest) (*http.Response, error) {
		var params intraoapi42.GetInternshipsParams
		if err := call.decodeQuery(&params); err != nil {
			return nil, err
		}
		return client.GetInternships(ctx, &params)
	},

	"getLanguageById": func(ctx context.Context, client intraoapi42.ClientInterface, call *callRequest) (*http.Response, error) {
		id, err := call.pathInt("id")
		if err != nil {
			return nil, err
		}
		return client.GetLanguageById(ctx, id)
	},

	"getUsers": func(ctx context.Context, client intraoapi42.ClientInterface, call *callRequest) (*http.Response, error) {
		var params intraoapi42.GetUsersParams
		if err := call.decodeQuery(&params); err != nil {
			return nil, err
		}
		return client.GetUsers(ctx, &params)
	},

	"getUserById": func(ctx context.Context, client intraoapi42.ClientInterface, call *callRequest) (*http.Response, error) {
		id, err := call.pathString("id")
		if err != nil {
			return nil, err
		}
		return client.GetUserById(ctx, id)
	},

	"getUserCandidatureById": func(ctx context.Context, client intraoapi42.ClientInterface, call *callRequest) (*http.Response, error) {
		id, err := call.pathString("id")
		if err != nil {
			return nil, err
		}
		return client.GetUserCandidatureById(ctx, id)
	},

	"getClosesByUserId": func(ctx context.Context, client intraoapi42.ClientInterface, call *callRequest) (*http.Response, error) {
		userID, err := call.pathInt("user_id")
		if err != nil {
			return nil, err
		}
		var params intraoapi42.GetClosesByUserIdParams
		if err := call.decodeQuery(&params); err != nil {
			return nil, err
		}
		return client.GetClosesByUserId(ctx, userID, &params)
	},
}

// SupportedOperations lists the operation ids the UI may call.
func SupportedOperations() []string {
	ids := make([]string, 0, len(registry))
	for id := range registry {
		ids = append(ids, id)
	}
	return ids
}
