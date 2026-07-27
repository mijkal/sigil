import Foundation

@MainActor
class AppViewModel: ObservableObject {
    @Published var client: SigilClient?
    @Published var isConfigured = false
    @Published var hubURL = ""
    @Published var authToken = ""

    init() {
        hubURL = KeychainHelper.shared.load(for: "sigil_hub_url") ?? ""
        authToken = KeychainHelper.shared.load(for: "sigil_token") ?? ""
        if !hubURL.isEmpty && !authToken.isEmpty {
            setupClient()
        }
    }

    func setupClient() {
        client = SigilClient(baseURL: hubURL, token: authToken)
        client?.connect()
        isConfigured = true
        KeychainHelper.shared.save(hubURL, for: "sigil_hub_url")
        KeychainHelper.shared.save(authToken, for: "sigil_token")
    }
}
