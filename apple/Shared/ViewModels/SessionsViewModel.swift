import Foundation

@MainActor
class SessionsViewModel: ObservableObject {
    @Published var hosts: [SigilHost] = []
    @Published var sessions: [SigilSession] = []
    @Published var isLoading = false
    @Published var error: String?

    private let client: SigilClient

    init(client: SigilClient) {
        self.client = client
    }

    func refresh() async {
        isLoading = true
        error = nil
        do {
            async let fetchedHosts = client.fetchHosts()
            async let fetchedSessions = client.fetchSessions()
            hosts = try await fetchedHosts
            sessions = try await fetchedSessions
        } catch let err {
            error = err.localizedDescription
        }
        isLoading = false
    }

    func createSession(hostName: String, name: String) async {
        error = nil
        do {
            let newSession = try await client.createSession(hostName: hostName, name: name)
            sessions.append(newSession)
        } catch let err {
            error = err.localizedDescription
        }
    }

    func deleteSession(id: String) async {
        error = nil
        do {
            try await client.deleteSession(id: id)
            sessions.removeAll { $0.id == id }
        } catch let err {
            error = err.localizedDescription
        }
    }

    func renameSession(id: String, newName: String) async {
        error = nil
        do {
            let updated = try await client.renameSession(id: id, newName: newName)
            if let idx = sessions.firstIndex(where: { $0.id == id }) {
                sessions[idx] = updated
            }
        } catch let err {
            error = err.localizedDescription
        }
    }
}
