import Foundation

@MainActor
class ChannelViewModel: ObservableObject {
    @Published var channelId: String?
    @Published var isAttached = false
    @Published var isClosed = false

    let hostName: String
    let sessionName: String
    let sessionId: String

    private let client: SigilClient
    var outputHandler: ((Data) -> Void)?
    private var unsubscribeOutput: (() -> Void)?
    private var unsubscribeClosed: (() -> Void)?

    init(client: SigilClient, hostName: String, sessionName: String, sessionId: String) {
        self.client = client
        self.hostName = hostName
        self.sessionName = sessionName
        self.sessionId = sessionId
    }

    func attach(rows: Int, cols: Int) async {
        guard !isAttached else { return }
        do {
            let cid = try await client.attach(hostName: hostName, sessionName: sessionName, rows: rows, cols: cols)
            channelId = cid
            isAttached = true

            // Subscribe to output
            unsubscribeOutput = client.onChannelOutput(channelId: cid) { [weak self] data in
                self?.outputHandler?(data)
            }

            // Subscribe to channel closed
            unsubscribeClosed = client.on(type: "channel_closed") { [weak self] payload in
                if let closedId = payload as? String, closedId == cid {
                    Task { @MainActor [weak self] in
                        self?.isClosed = true
                        self?.isAttached = false
                    }
                }
            }
        } catch {
            // Attach failed; leave isAttached = false
        }
    }

    func detach() async {
        guard let cid = channelId, isAttached else { return }
        unsubscribeOutput?()
        unsubscribeClosed?()
        unsubscribeOutput = nil
        unsubscribeClosed = nil
        try? await client.detach(channelId: cid)
        isAttached = false
        channelId = nil
    }

    func sendInput(_ data: Data) {
        guard let cid = channelId else { return }
        try? client.sendInput(channelId: cid, data: data)
    }

    func resize(rows: Int, cols: Int) {
        guard let cid = channelId else { return }
        try? client.resize(channelId: cid, rows: rows, cols: cols)
    }
}
