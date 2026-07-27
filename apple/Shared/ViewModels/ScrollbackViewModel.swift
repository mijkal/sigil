import Foundation

@MainActor
final class ScrollbackViewModel: ObservableObject {
    @Published var isVisible = false
    @Published var chunks: [ScrollbackChunk] = []
    @Published var isLoading = false
    @Published var errorMessage: String?

    private let client: SigilClient
    let sessionId: String

    init(client: SigilClient, sessionId: String) {
        self.client = client
        self.sessionId = sessionId
    }

    func open() {
        guard !isVisible else { return }
        isVisible = true
        chunks = []
        errorMessage = nil
        Task { await load() }
    }

    func close() {
        isVisible = false
        chunks = []
        errorMessage = nil
    }

    private func load() async {
        isLoading = true
        do {
            chunks = try await client.fetchScrollback(sessionId: sessionId, limit: 500)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
