package main

import (
	"net/http/httptest"
	"testing"
)

// The cache policy is what lets an installed home-screen app pick up a redeploy
// on its own. Sigil ships no service worker, so HTTP caching is the ONLY update
// mechanism — if the shell goes stale there is no worker to swap it out and no
// browser chrome to reload from, and the app looks like it needs reinstalling.
func TestShellAndUnhashedAssetsRevalidate(t *testing.T) {
	for _, p := range []string{
		"/",
		"/index.html",
		"/manifest.webmanifest",
		"/apple-touch-icon.png",
		"/splash/iphone16pro-portrait.png",
	} {
		w := httptest.NewRecorder()
		setCacheHeaders(w, p)
		if got := w.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control = %q, want no-cache", p, got)
		}
	}
}

func TestHashedAssetsAreImmutable(t *testing.T) {
	// Vite content-hashes everything under /assets/, so the URL changes whenever
	// the bytes do. That is what keeps revalidating the shell cheap.
	w := httptest.NewRecorder()
	setCacheHeaders(w, "/assets/index-A1b2C3d4.js")
	if got := w.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("hashed asset: Cache-Control = %q", got)
	}
}
