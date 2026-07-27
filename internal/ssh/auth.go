package sshpool

import (
	"fmt"
	"net"
	"os"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"sigil.dev/sigil/internal/config"
)

// BuildAuthMethods builds SSH auth methods from host config
func BuildAuthMethods(hc config.HostConfig) ([]ssh.AuthMethod, error) {
	switch hc.AuthMethod {
	case "key":
		return buildKeyAuth(hc)
	case "agent":
		return buildAgentAuth()
	case "password":
		return []ssh.AuthMethod{ssh.Password(hc.Password)}, nil
	default:
		// Try key first, then agent
		methods, err := buildKeyAuth(hc)
		if err == nil {
			return methods, nil
		}
		return buildAgentAuth()
	}
}

func expandHome(path string) string {
	if len(path) >= 2 && path[:2] == "~/" {
		home, err := os.UserHomeDir()
		if err == nil {
			return home + path[1:]
		}
	}
	return path
}

func buildKeyAuth(hc config.HostConfig) ([]ssh.AuthMethod, error) {
	keyPath := expandHome(hc.PrivateKeyPath)
	if keyPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("get home dir: %w", err)
		}
		// Try common key paths
		candidates := []string{
			home + "/.ssh/id_ed25519",
			home + "/.ssh/id_rsa",
			home + "/.ssh/id_ecdsa",
		}
		for _, p := range candidates {
			if _, err := os.Stat(p); err == nil {
				keyPath = p
				break
			}
		}
		if keyPath == "" {
			return nil, fmt.Errorf("no private key found")
		}
	}

	data, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("read key file %s: %w", keyPath, err)
	}

	signer, err := ssh.ParsePrivateKey(data)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}

	return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
}

func buildAgentAuth() ([]ssh.AuthMethod, error) {
	sockPath := os.Getenv("SSH_AUTH_SOCK")
	if sockPath == "" {
		return nil, fmt.Errorf("SSH_AUTH_SOCK not set")
	}

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return nil, fmt.Errorf("connect to ssh-agent: %w", err)
	}

	agentClient := agent.NewClient(conn)
	return []ssh.AuthMethod{ssh.PublicKeysCallback(agentClient.Signers)}, nil
}
