# Multi-stage build for sigild
# Stage 1: Build web client
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --silent
COPY web/ .
RUN npm run build

# Stage 2: Build Go binary
FROM golang:1.22-alpine AS go-builder
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-builder /app/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /sigild ./cmd/sigild

# Stage 3: Minimal runtime
FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
COPY --from=go-builder /sigild /usr/local/bin/sigild
EXPOSE 7777
VOLUME ["/data", "/config"]
ENTRYPOINT ["/usr/local/bin/sigild"]
CMD ["--config", "/config/config.toml"]
