package api

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// Iframe proxy — fetch a URL server-side and return it framable (strip
// X-Frame-Options / frame-ancestors, inject a <base>), so a session's links can be
// opened inside sigil instead of a new tab even when the site refuses to frame.
//
// SSRF policy (mirrors Mission Control's proxy): any PUBLIC host is allowed
// (SIGIL_PROXY_PUBLIC != "0"); PRIVATE/LAN addresses only if in an allowlisted CIDR
// (SIGIL_PROXY_ALLOW); loopback / link-local / metadata always blocked; redirects
// re-validated per hop.

var (
	proxyAllowPublic = os.Getenv("SIGIL_PROXY_PUBLIC") != "0"
	proxyCIDRs       = parseProxyCIDRs(os.Getenv("SIGIL_PROXY_ALLOW"))
	proxyHeadRe      = regexp.MustCompile(`(?i)(<head[^>]*>)`)
	proxyMaxBytes    = int64(6 * 1024 * 1024)
)

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func parseProxyCIDRs(s string) []*net.IPNet {
	var out []*net.IPNet
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if _, n, err := net.ParseCIDR(p); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func ipInCIDRs(ip net.IP) bool {
	for _, n := range proxyCIDRs {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// validateProxyURL enforces the SSRF policy against every resolved IP.
func validateProxyURL(raw string) (bool, string) {
	u, err := url.Parse(raw)
	if err != nil {
		return false, "malformed url"
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false, "only http(s) is proxied"
	}
	host := u.Hostname()
	if host == "" {
		return false, "no host"
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return false, "dns resolution failed"
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			return false, "blocked address " + ip.String()
		}
		public := !(ip.IsPrivate() || ip.IsMulticast())
		if public {
			if !proxyAllowPublic {
				return false, host + " is not allowed"
			}
		} else if !ipInCIDRs(ip) {
			return false, "private address " + ip.String() + " is not in an allowlisted range"
		}
	}
	return true, ""
}

// ProxyURL: GET /api/v1/proxy?url=...&token=... — returns the target framable.
func (s *Server) ProxyURL(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	if raw == "" {
		writeError(w, 400, "bad_request", "url is required")
		return
	}
	if ok, reason := validateProxyURL(raw); !ok {
		writeError(w, 403, "proxy_blocked", reason)
		return
	}
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 4 {
				return fmt.Errorf("too many redirects")
			}
			if ok, reason := validateProxyURL(req.URL.String()); !ok {
				return fmt.Errorf("redirect blocked: %s", reason)
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, raw, nil)
	if err != nil {
		writeError(w, 400, "bad_request", err.Error())
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Sigil review proxy)")
	resp, err := client.Do(req)
	if err != nil {
		writeError(w, 502, "proxy_fetch_failed", err.Error())
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, proxyMaxBytes))

	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "text/html"
	}
	if strings.Contains(strings.ToLower(ct), "text/html") {
		final := raw
		if resp.Request != nil && resp.Request.URL != nil {
			final = resp.Request.URL.String()
		}
		html := string(body)
		base := `<base href="` + final + `">`
		if loc := proxyHeadRe.FindStringIndex(html); loc != nil {
			html = html[:loc[1]] + base + html[loc[1]:]
		} else {
			html = base + html
		}
		body = []byte(html)
		ct = "text/html; charset=utf-8"
	}
	// Strip framing protection by not copying it; set our own permissive framing.
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Security-Policy", "frame-ancestors 'self'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}
