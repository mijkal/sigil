.PHONY: all build build-web build-cli build-linux build-linux-arm64 deploy clean dev test lint sync-mac

BINARY     := sigild
VERSION    := 0.1.2
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
BUILD_DATE := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_DIR  := dist
GO_FLAGS   := -ldflags="-s -w -X sigil.dev/sigil/pkg/sigil.Version=$(VERSION) -X sigil.dev/sigil/pkg/sigil.GitCommit=$(GIT_COMMIT) -X sigil.dev/sigil/pkg/sigil.BuildDate=$(BUILD_DATE)"
# Override for your own deployment, e.g. SIGIL_HOST=user@host make deploy
UTOPIA     := $(or $(SIGIL_HOST),user@sigil-host)
HOKULEA    := $(or $(SIGIL_MAC_HOST),user@mac-host)
HOKULEA_PATH := /Volumes/Scratch/dev/sigil

all: build

## build-web: Build the React web client into web/dist/
build-web:
	@echo "→ Building web client..."
	cd web && npm install --silent && npm run build
	@echo "✓ web/dist/ ready"

## build: Build sigild, sigil-web and sigil binaries (native)
build: build-cli
	@echo "→ Building sigild + sigil-web..."
	@mkdir -p $(BUILD_DIR)
	go build $(GO_FLAGS) -o $(BUILD_DIR)/$(BINARY) ./cmd/sigild
	go build $(GO_FLAGS) -o $(BUILD_DIR)/sigil-web ./cmd/sigil-web
	@echo "✓ $(BUILD_DIR)/sigild  $(BUILD_DIR)/sigil-web  $(BUILD_DIR)/sigil"

## build-cli: Build the sigil terminal launcher (native, not deployed)
build-cli:
	@mkdir -p $(BUILD_DIR)
	go build $(GO_FLAGS) -o $(BUILD_DIR)/sigil ./cmd/sigil
	@echo "✓ $(BUILD_DIR)/sigil"

## build-linux: Cross-compile for Linux amd64 (Utopia target)
build-linux:
	@mkdir -p $(BUILD_DIR)
	GOOS=linux GOARCH=amd64 go build $(GO_FLAGS) -o $(BUILD_DIR)/$(BINARY)-linux-amd64 ./cmd/sigild
	GOOS=linux GOARCH=amd64 go build $(GO_FLAGS) -o $(BUILD_DIR)/sigil-web-linux-amd64 ./cmd/sigil-web
	@echo "✓ $(BUILD_DIR)/sigild-linux-amd64  $(BUILD_DIR)/sigil-web-linux-amd64"

## build-linux-arm64: Cross-compile for Linux arm64
build-linux-arm64:
	@mkdir -p $(BUILD_DIR)
	GOOS=linux GOARCH=arm64 go build $(GO_FLAGS) -o $(BUILD_DIR)/$(BINARY)-linux-arm64 ./cmd/sigild
	GOOS=linux GOARCH=arm64 go build $(GO_FLAGS) -o $(BUILD_DIR)/sigil-web-linux-arm64 ./cmd/sigil-web
	@echo "✓ $(BUILD_DIR)/sigild-linux-arm64  $(BUILD_DIR)/sigil-web-linux-arm64"

## deploy: Build everything and deploy to Utopia (sigild daemon + webapp)
## Syncthing handles source sync; this pushes binaries and web/dist (excluded from Syncthing)
deploy: build-web build-linux
	@echo "→ Deploying to $(UTOPIA)..."
	@# Push built webapp (not synced by Syncthing — dist/ is in .stignore)
	rsync -az --delete web/dist/ $(UTOPIA):/data/projects/sigil/web/dist/
	@# Push binaries to /usr/local/bin via sudo
	rsync -az $(BUILD_DIR)/$(BINARY)-linux-amd64 $(UTOPIA):/tmp/sigild-new
	rsync -az $(BUILD_DIR)/sigil-web-linux-amd64 $(UTOPIA):/tmp/sigil-web-new
	ssh $(UTOPIA) "sudo mv /tmp/sigild-new /usr/local/bin/sigild && sudo mv /tmp/sigil-web-new /usr/local/bin/sigil-web && sudo chmod +x /usr/local/bin/sigild /usr/local/bin/sigil-web"
	@# Restart services
	ssh $(UTOPIA) "sudo systemctl restart sigild sigil-web"
	@echo "✓ Deployed — webapp :7777  API :7778"

## deploy-web: NON-DISRUPTIVE frontend-only deploy. Swaps web/dist on the serving
## host with NO binary push and NO daemon restart, so live tmux sessions keep
## running and users pick up changes on their next browser reload. Use this
## instead of `deploy` while WIP sessions are live.
deploy-web: build-web
	@echo "→ Deploying web/dist to $(UTOPIA) (no restart)..."
	rsync -az --delete web/dist/ $(UTOPIA):/data/projects/sigil/web/dist.new/
	ssh $(UTOPIA) "cd /data/projects/sigil/web && rm -rf dist.old && { [ -d dist ] && mv dist dist.old || true; } && mv dist.new dist"
	@echo "✓ web/dist swapped atomically — reload browser to pick up. sigild untouched."

## dev: Run sigild locally (API only, no web)
dev:
	go run ./cmd/sigild --config ~/.config/sigil/config.toml

## test: Run Go unit tests
test:
	go test ./... -v -timeout 60s

## test-integration: Run integration tests (requires Docker)
test-integration:
	docker-compose -f test/docker-compose.test.yml up -d
	go test ./test/integration/... -v -timeout 120s
	docker-compose -f test/docker-compose.test.yml down

## lint: Run golangci-lint
lint:
	golangci-lint run ./...

## clean: Remove build artifacts
clean:
	rm -rf $(BUILD_DIR) web/dist

## sync-mac: Sync the project to a macOS host for Apple app development
sync-mac:
	@echo "→ Syncing to Hokulea $(HOKULEA):$(HOKULEA_PATH)..."
	rsync -avz --exclude='.git' --exclude='web/node_modules' --exclude='dist' \
		--exclude='apple/DerivedData' --exclude='*.db' \
		./ $(HOKULEA):$(HOKULEA_PATH)/
	@echo "✓ Synced to Hokulea"

## setup-config: Create default config file
setup-config:
	@mkdir -p ~/.config/sigil ~/.local/share/sigil
	@if [ ! -f ~/.config/sigil/config.toml ]; then \
		cp config.example.toml ~/.config/sigil/config.toml; \
		echo "✓ Config created at ~/.config/sigil/config.toml"; \
		echo "  Edit it to configure your SSH hosts and auth token"; \
	else \
		echo "Config already exists at ~/.config/sigil/config.toml"; \
	fi

help:
	@grep -E '^## ' Makefile | sed 's/## //'
