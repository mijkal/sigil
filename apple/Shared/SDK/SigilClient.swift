import Foundation

// MARK: - Types

struct SigilHost: Codable, Identifiable {
    let name: String
    var hostname: String
    var port: Int
    var user: String
    var status: String
    var tags: [String]
    var error: String?
    var id: String { name }
}

struct ScrollbackChunk: Codable {
    let data: String  // base64-encoded PTY output
}

struct SigilSession: Codable, Identifiable {
    let id: String
    var hostName: String
    var name: String
    var windows: Int
    var tags: [String]
    var createdAt: String
    var lastActive: String
    var status: String

    enum CodingKeys: String, CodingKey {
        case id, name, windows, tags, status
        case hostName = "host_name"
        case createdAt = "created_at"
        case lastActive = "last_active"
    }
}

struct WsMessage: Codable {
    var type: String
    var id: String?
    var channelId: String?
    var payload: AnyCodable?

    enum CodingKeys: String, CodingKey {
        case type, id, payload
        case channelId = "channel_id"
    }
}

// MARK: - AnyCodable

struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "AnyCodable: unsupported type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            let context = EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "AnyCodable: unsupported type \(type(of: value))")
            throw EncodingError.invalidValue(value, context)
        }
    }
}

// MARK: - REST Envelope

private struct APIResponse<T: Decodable>: Decodable {
    let data: T?
    let error: String?
}

// MARK: - SigilClient

@MainActor
class SigilClient: ObservableObject {
    @Published var isConnected = false
    @Published var hosts: [SigilHost] = []
    @Published var sessions: [SigilSession] = []

    private var wsTask: URLSessionWebSocketTask?
    private let session = URLSession.shared
    private var baseURL: String
    private var token: String
    private var channelHandlers: [String: (Data) -> Void] = [:]
    private var messageHandlers: [String: [(Any) -> Void]] = [:]
    private var pingTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?

    init(baseURL: String, token: String) {
        self.baseURL = baseURL
        self.token = token
    }

    // MARK: - Connection

    func connect() {
        guard let wsURL = buildWSURL() else { return }
        var request = URLRequest(url: wsURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        wsTask = session.webSocketTask(with: request)
        wsTask?.resume()

        // Send auth message
        let authMsg: [String: Any] = [
            "type": "auth",
            "payload": [
                "token": token,
                "client_info": ["type": "apple"]
            ]
        ]
        try? sendMessage(authMsg)

        // Start receive loop
        startReceiveLoop()

        // Start ping every 25s
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard let self, !Task.isCancelled else { break }
                try? self.wsTask?.sendPing { _ in }
            }
        }
    }

    func disconnect() {
        pingTask?.cancel()
        receiveTask?.cancel()
        wsTask?.cancel(with: .normalClosure, reason: nil)
        wsTask = nil
        isConnected = false
    }

    // MARK: - WebSocket Internal

    private func buildWSURL() -> URL? {
        var urlString = baseURL
        if urlString.hasPrefix("https://") {
            urlString = "wss://" + urlString.dropFirst("https://".count)
        } else if urlString.hasPrefix("http://") {
            urlString = "ws://" + urlString.dropFirst("http://".count)
        }
        // Ensure no trailing slash before appending path
        urlString = urlString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        urlString += "/ws"
        return URL(string: urlString)
    }

    private func startReceiveLoop() {
        receiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, let wsTask = self.wsTask {
                do {
                    let message = try await wsTask.receive()
                    var jsonData: Data?
                    switch message {
                    case .string(let str):
                        jsonData = str.data(using: .utf8)
                    case .data(let data):
                        jsonData = data
                    @unknown default:
                        break
                    }
                    if let jsonData, let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                        await MainActor.run { self.handleMessage(obj) }
                    }
                } catch {
                    await MainActor.run { self.isConnected = false }
                    break
                }
            }
        }
    }

    private func handleMessage(_ msg: [String: Any]) {
        guard let type = msg["type"] as? String else { return }

        switch type {
        case "auth_ok":
            isConnected = true
        case "channel_output":
            if let channelId = msg["channel_id"] as? String,
               let payload = msg["payload"] as? String,
               let data = Data(base64Encoded: payload) {
                channelHandlers[channelId]?(data)
            }
        case "channel_closed":
            if let channelId = msg["channel_id"] as? String {
                messageHandlers["channel_closed"]?.forEach { $0(channelId) }
            }
        case "hosts_update":
            if let payload = msg["payload"],
               let data = try? JSONSerialization.data(withJSONObject: payload),
               let hosts = try? JSONDecoder().decode([SigilHost].self, from: data) {
                self.hosts = hosts
            }
        case "sessions_update":
            if let payload = msg["payload"],
               let data = try? JSONSerialization.data(withJSONObject: payload),
               let sessions = try? JSONDecoder().decode([SigilSession].self, from: data) {
                self.sessions = sessions
            }
        default:
            messageHandlers[type]?.forEach { $0(msg) }
        }
    }

    func sendMessage(_ msg: [String: Any]) throws {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { return }
        wsTask?.send(.string(str)) { _ in }
    }

    // MARK: - WebSocket Operations

    func attach(hostName: String, sessionName: String, rows: Int, cols: Int) async throws -> String {
        let msgId = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            var didResume = false
            let handler: (Any) -> Void = { [weak self] payload in
                guard !didResume else { return }
                if let dict = payload as? [String: Any],
                   dict["id"] as? String == msgId,
                   let channelId = dict["channel_id"] as? String {
                    didResume = true
                    _ = self?.on(type: "attach_ok", handler: { _ in }) // remove by re-registering empty
                    continuation.resume(returning: channelId)
                }
            }
            let _ = on(type: "attach_ok", handler: handler)
            let msg: [String: Any] = [
                "type": "attach",
                "id": msgId,
                "payload": [
                    "host_name": hostName,
                    "session_name": sessionName,
                    "rows": rows,
                    "cols": cols
                ]
            ]
            try? sendMessage(msg)
        }
    }

    func detach(channelId: String) async throws {
        let msg: [String: Any] = [
            "type": "detach",
            "channel_id": channelId
        ]
        try sendMessage(msg)
    }

    func sendInput(channelId: String, data: Data) throws {
        let msg: [String: Any] = [
            "type": "input",
            "channel_id": channelId,
            "payload": data.base64EncodedString()
        ]
        try sendMessage(msg)
    }

    func resize(channelId: String, rows: Int, cols: Int) throws {
        let msg: [String: Any] = [
            "type": "resize",
            "channel_id": channelId,
            "payload": ["rows": rows, "cols": cols]
        ]
        try sendMessage(msg)
    }

    // MARK: - REST Operations

    private func buildURL(_ path: String) -> URL? {
        var base = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: base + path)
    }

    private func makeRequest(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard let url = buildURL(path) else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    func fetchHosts() async throws -> [SigilHost] {
        let req = try makeRequest("/api/hosts")
        let (data, _) = try await session.data(for: req)
        let envelope = try JSONDecoder().decode(APIResponse<[SigilHost]>.self, from: data)
        if let error = envelope.error { throw NSError(domain: "SigilClient", code: 0, userInfo: [NSLocalizedDescriptionKey: error]) }
        let result = envelope.data ?? []
        self.hosts = result
        return result
    }

    func fetchSessions() async throws -> [SigilSession] {
        let req = try makeRequest("/api/sessions")
        let (data, _) = try await session.data(for: req)
        let envelope = try JSONDecoder().decode(APIResponse<[SigilSession]>.self, from: data)
        if let error = envelope.error { throw NSError(domain: "SigilClient", code: 0, userInfo: [NSLocalizedDescriptionKey: error]) }
        let result = envelope.data ?? []
        self.sessions = result
        return result
    }

    func createSession(hostName: String, name: String) async throws -> SigilSession {
        let req = try makeRequest("/api/sessions", method: "POST", body: ["host_name": hostName, "name": name])
        let (data, _) = try await session.data(for: req)
        let envelope = try JSONDecoder().decode(APIResponse<SigilSession>.self, from: data)
        if let error = envelope.error { throw NSError(domain: "SigilClient", code: 0, userInfo: [NSLocalizedDescriptionKey: error]) }
        guard let created = envelope.data else { throw URLError(.cannotParseResponse) }
        return created
    }

    func deleteSession(id: String) async throws {
        let req = try makeRequest("/api/sessions/\(id)", method: "DELETE")
        let (_, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw NSError(domain: "SigilClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "Delete failed"])
        }
    }

    func fetchScrollback(sessionId: String, limit: Int) async throws -> [ScrollbackChunk] {
        let req = try makeRequest("/api/sessions/\(sessionId)/scrollback?limit=\(limit)")
        let (data, _) = try await session.data(for: req)
        let envelope = try JSONDecoder().decode(APIResponse<[ScrollbackChunk]>.self, from: data)
        return envelope.data ?? []
    }

    func renameSession(id: String, newName: String) async throws -> SigilSession {
        let req = try makeRequest("/api/sessions/\(id)", method: "PUT", body: ["name": newName])
        let (data, _) = try await session.data(for: req)
        let envelope = try JSONDecoder().decode(APIResponse<SigilSession>.self, from: data)
        if let error = envelope.error {
            throw NSError(domain: "SigilClient", code: 0, userInfo: [NSLocalizedDescriptionKey: error])
        }
        guard let updated = envelope.data else { throw URLError(.cannotParseResponse) }
        return updated
    }

    func search(query: String) async throws -> [[String: Any]] {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let req = try makeRequest("/api/search?q=\(encoded)")
        let (data, _) = try await session.data(for: req)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let results = json["data"] as? [[String: Any]] else {
            return []
        }
        return results
    }

    // MARK: - Event Subscriptions

    func onChannelOutput(channelId: String, handler: @escaping (Data) -> Void) -> () -> Void {
        channelHandlers[channelId] = handler
        return { [weak self] in
            self?.channelHandlers.removeValue(forKey: channelId)
        }
    }

    func on(type: String, handler: @escaping (Any) -> Void) -> () -> Void {
        if messageHandlers[type] == nil {
            messageHandlers[type] = []
        }
        messageHandlers[type]?.append(handler)
        let index = (messageHandlers[type]?.count ?? 1) - 1
        return { [weak self] in
            self?.messageHandlers[type]?.remove(at: index)
        }
    }
}
