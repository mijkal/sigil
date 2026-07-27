import Foundation

/// A saved layout: ordered list of panes, each with ordered tabs.
struct WorkspaceLayout: Codable, Identifiable {
    var id: String
    var name: String
    var panes: [PaneLayout]

    struct PaneLayout: Codable {
        var tabs: [TabLayout]
        var activeTabIdx: Int
    }

    struct TabLayout: Codable {
        var hostName: String
        var sessionName: String
        var sessionId: String
    }
}

@MainActor
final class WorkspaceViewModel: ObservableObject {
    @Published var workspaces: [WorkspaceLayout] = []
    @Published var activeWorkspaceId: String?

    private let storageKey = "sigil_workspaces"
    private let activeKey  = "sigil_active_workspace"

    init() {
        load()
    }

    // MARK: - Persistence (UserDefaults for now; Keychain migration is Phase 3+)

    func save(id: String, name: String, panes: [MainView.Pane]) {
        let layout = WorkspaceLayout(
            id: id,
            name: name,
            panes: panes.map { pane in
                WorkspaceLayout.PaneLayout(
                    tabs: pane.tabs.map { tab in
                        WorkspaceLayout.TabLayout(
                            hostName: tab.hostName,
                            sessionName: tab.sessionName,
                            sessionId: tab.sessionId
                        )
                    },
                    activeTabIdx: pane.activeTabIdx
                )
            }
        )
        if let idx = workspaces.firstIndex(where: { $0.id == id }) {
            workspaces[idx] = layout
        } else {
            workspaces.append(layout)
        }
        activeWorkspaceId = id
        persist()
    }

    func restore(id: String) -> [MainView.Pane]? {
        guard let layout = workspaces.first(where: { $0.id == id }) else { return nil }
        activeWorkspaceId = id
        UserDefaults.standard.set(id, forKey: activeKey)
        return layout.panes.map { paneLayout in
            var pane = MainView.Pane(
                tabs: paneLayout.tabs.map { tabLayout in
                    MainView.Tab(
                        hostName: tabLayout.hostName,
                        sessionName: tabLayout.sessionName,
                        sessionId: tabLayout.sessionId
                    )
                }
            )
            pane.activeTabIdx = paneLayout.activeTabIdx
            return pane
        }
    }

    func delete(id: String) {
        workspaces.removeAll { $0.id == id }
        if activeWorkspaceId == id { activeWorkspaceId = nil }
        persist()
    }

    func createDefault() -> String {
        let id = UUID().uuidString
        workspaces.append(WorkspaceLayout(id: id, name: "Default", panes: []))
        activeWorkspaceId = id
        persist()
        return id
    }

    // MARK: - Internal

    private func persist() {
        guard let data = try? JSONEncoder().encode(workspaces) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
        if let id = activeWorkspaceId {
            UserDefaults.standard.set(id, forKey: activeKey)
        }
    }

    private func load() {
        if let data = UserDefaults.standard.data(forKey: storageKey),
           let decoded = try? JSONDecoder().decode([WorkspaceLayout].self, from: data) {
            workspaces = decoded
        }
        activeWorkspaceId = UserDefaults.standard.string(forKey: activeKey)
    }
}
