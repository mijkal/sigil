// sigil-web serves the Sigil web client as a standalone static file server.
// When -backend is specified, it also reverse-proxies /api/ and /ws requests
// to the sigild daemon, so the browser only needs to know about one port.
//
// Usage:
//
//	sigil-web [-dir ./web/dist] [-addr 0.0.0.0:7777] [-backend http://localhost:7778]
package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// setCacheHeaders picks a cache policy by path: Vite content-hashes everything
// under /assets/, so those are immutable forever; the SPA shell + unhashed icons
// and the PWA manifest must revalidate every load so a redeploy shows up without
// the user clearing their cache (browsers cache favicons especially aggressively).
func setCacheHeaders(w http.ResponseWriter, p string) {
	if strings.HasPrefix(p, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
}

func main() {
	dir := flag.String("dir", "./web/dist", "directory containing the built webapp (index.html must be at root)")
	addr := flag.String("addr", "0.0.0.0:7777", "listen address")
	backend := flag.String("backend", "", "sigild backend URL to reverse-proxy /api/ and /ws to (e.g. http://localhost:7778)")
	flag.Parse()

	abs, err := filepath.Abs(*dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sigil-web: invalid dir: %v\n", err)
		os.Exit(1)
	}
	if _, err := os.Stat(filepath.Join(abs, "index.html")); err != nil {
		fmt.Fprintf(os.Stderr, "sigil-web: no index.html in %s — run 'npm run build' in web/ first\n", abs)
		os.Exit(1)
	}

	// SPA handler: serve static files; fall back to index.html for unknown paths
	// so that client-side routing works correctly.
	fs := http.FileServer(http.Dir(abs))
	mux := http.NewServeMux()

	// Reverse proxy for API and WebSocket traffic when -backend is set
	if *backend != "" {
		backendURL, err := url.Parse(*backend)
		if err != nil {
			fmt.Fprintf(os.Stderr, "sigil-web: invalid backend URL: %v\n", err)
			os.Exit(1)
		}
		proxy := httputil.NewSingleHostReverseProxy(backendURL)
		origDirector := proxy.Director
		proxy.Director = func(req *http.Request) {
			origDirector(req)
			req.Host = backendURL.Host
		}
		mux.HandleFunc("/api/", proxy.ServeHTTP)
		mux.HandleFunc("/ws", proxy.ServeHTTP)
		fmt.Printf("sigil-web  proxying /api/ and /ws → %s\n", *backend)
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Don't accidentally serve index.html for /api/ or /ws if backend is unset
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/ws" {
			http.NotFound(w, r)
			return
		}
		setCacheHeaders(w, r.URL.Path)
		// Check if the file exists; if not, serve index.html for SPA routing
		path := filepath.Join(abs, filepath.Clean("/"+r.URL.Path))
		if _, err := os.Stat(path); os.IsNotExist(err) {
			// SPA fallback: the shell must always revalidate so a redeploy is picked
			// up without a manual cache clear.
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(abs, "index.html"))
			return
		}
		fs.ServeHTTP(w, r)
	})

	fmt.Printf("sigil-web  serving %s on http://%s\n", abs, *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		fmt.Fprintf(os.Stderr, "sigil-web: %v\n", err)
		os.Exit(1)
	}
}
