package events

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/rs/zerolog"
)

// Client dispatches webhook requests
type Client struct {
	httpClient *http.Client
	log        zerolog.Logger
}

// NewWebhookClient creates a new webhook client
func NewWebhookClient() *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 10 * time.Second},
		log:        zerolog.Nop(),
	}
}

// SetLogger sets the logger
func (c *Client) SetLogger(log zerolog.Logger) {
	c.log = log
}

// Dispatch sends a webhook POST with HMAC-SHA256 signature, retrying up to 3 times
func (c *Client) Dispatch(url string, secret string, payload interface{}) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	sig := computeHMAC(secret, data)

	delays := []time.Duration{time.Second, 5 * time.Second, 30 * time.Second}
	var lastErr error

	for attempt := 0; attempt <= 3; attempt++ {
		if attempt > 0 {
			if attempt-1 < len(delays) {
				time.Sleep(delays[attempt-1])
			}
		}

		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
		if err != nil {
			return fmt.Errorf("create request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Sigil-Signature", "sha256="+sig)

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			c.log.Warn().Err(err).Str("url", url).Int("attempt", attempt+1).Msg("webhook failed")
			continue
		}
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}

		lastErr = fmt.Errorf("webhook returned status %d", resp.StatusCode)
		c.log.Warn().Int("status", resp.StatusCode).Str("url", url).Int("attempt", attempt+1).Msg("webhook non-2xx")
	}

	return lastErr
}

func computeHMAC(secret string, data []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}
