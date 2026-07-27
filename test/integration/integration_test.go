package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

const (
	testHubAddr = "http://localhost:17777"
	testWsAddr  = "ws://localhost:17777"
	testToken   = "integration-test-token"
)

// startTestHub starts a sigild instance for testing.
// Requires the binary to be built first.
func startTestHub(t *testing.T) func() {
	t.Helper()
	// TODO: Start sigild with test config pointing to Docker SSH servers
	// For now, tests assume sigild is running externally
	return func() {}
}

func TestStatus(t *testing.T) {
	resp, err := httpGet(t, "/api/v1/status")
	if err != nil {
		t.Skipf("Hub not running: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
}

func TestWebSocketAuth(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, testWsAddr+"/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer " + testToken},
		},
		Subprotocols: []string{"sigil.v1"},
	})
	if err != nil {
		t.Skipf("Hub not running: %v", err)
	}
	defer conn.CloseNow()

	// Send auth message
	authMsg := map[string]interface{}{
		"type":    "auth",
		"payload": map[string]interface{}{"token": testToken, "client_info": map[string]string{"type": "test"}},
	}
	if err := wsjson.Write(ctx, conn, authMsg); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	// Read auth result
	var result map[string]interface{}
	if err := wsjson.Read(ctx, conn, &result); err != nil {
		t.Fatalf("read auth result: %v", err)
	}

	if result["type"] != "auth.result" {
		t.Fatalf("expected auth.result, got %v", result["type"])
	}
	payload, ok := result["payload"].(map[string]interface{})
	if !ok {
		t.Fatal("expected payload object")
	}
	if payload["success"] != true {
		t.Fatalf("auth failed: %v", payload)
	}
	t.Logf("Auth succeeded, client_id: %v", payload["client_id"])
}

func TestGetHosts(t *testing.T) {
	resp, err := httpGet(t, "/api/v1/hosts")
	if err != nil {
		t.Skipf("Hub not running: %v", err)
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	t.Logf("Hosts response: %v", result)
}

func TestGetSessions(t *testing.T) {
	resp, err := httpGet(t, "/api/v1/sessions")
	if err != nil {
		t.Skipf("Hub not running: %v", err)
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	t.Logf("Sessions response: %v", result)
}

func httpGet(t *testing.T, path string) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequest("GET", testHubAddr+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("hub not reachable: %w", err)
	}
	return resp, nil
}

// TestPing verifies WebSocket ping/pong works
func TestPing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, testWsAddr+"/ws", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + testToken}},
		Subprotocols: []string{"sigil.v1"},
	})
	if err != nil {
		t.Skipf("Hub not running: %v", err)
	}
	defer conn.CloseNow()

	// Auth first
	_ = wsjson.Write(ctx, conn, map[string]interface{}{
		"type":    "auth",
		"payload": map[string]interface{}{"token": testToken},
	})
	var authResult map[string]interface{}
	_ = wsjson.Read(ctx, conn, &authResult)

	// Send ping
	if err := wsjson.Write(ctx, conn, map[string]interface{}{"type": "ping"}); err != nil {
		t.Fatalf("write ping: %v", err)
	}

	// Read pong
	var pong map[string]interface{}
	if err := wsjson.Read(ctx, conn, &pong); err != nil {
		t.Fatalf("read pong: %v", err)
	}
	if !strings.EqualFold(fmt.Sprint(pong["type"]), "pong") {
		t.Fatalf("expected pong, got %v", pong["type"])
	}
	t.Log("Ping/pong OK")
}
