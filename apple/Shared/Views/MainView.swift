import SwiftUI

struct MainView: View {
    let client: SigilClient
    @StateObject private var sessionsVM: SessionsViewModel
    @StateObject private var workspaceVM = WorkspaceViewModel()
    @State private var panes: [Pane] = []
    @State private var showCommandPalette = false
    @State private var showHosts = false
    @State private var showWorkspaces = false
    @State private var activeWorkspaceId: String?

    // A pane holds an ordered list of tabs; only the active tab is visible.
    struct Tab: Identifiable {
        let id = UUID().uuidString
        let hostName: String
        let sessionName: String
        let sessionId: String
    }

    struct Pane: Identifiable {
        let id = UUID().uuidString
        var tabs: [Tab]
        var activeTabIdx: Int = 0

        var activeTab: Tab? { tabs.indices.contains(activeTabIdx) ? tabs[activeTabIdx] : tabs.first }
    }

    init(client: SigilClient) {
        self.client = client
        _sessionsVM = StateObject(wrappedValue: SessionsViewModel(client: client))
    }

    var body: some View {
        NavigationSplitView {
            SidebarView(
                sessionsVM: sessionsVM,
                onOpen: openSessionInNewPane,
                onOpenInPane: openSessionInFocusedPane
            )
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    Button { showHosts = true } label: {
                        Image(systemName: "server.rack")
                    }
                    .help("Hosts")
                }
                ToolbarItem(placement: .automatic) {
                    Button { showWorkspaces.toggle() } label: {
                        Image(systemName: "rectangle.3.group")
                    }
                    .help("Workspaces")
                }
            }
        } detail: {
            PaneGridView(
                panes: $panes,
                client: client,
                onClosePane: closePane
            )
        }
        .task {
            await sessionsVM.refresh()
            // Restore last active workspace on launch
            if let wsId = workspaceVM.activeWorkspaceId,
               let restored = workspaceVM.restore(id: wsId) {
                panes = restored
                activeWorkspaceId = wsId
            }
        }
        // Real-time session updates from hub WebSocket
        .onReceive(client.$sessions) { updated in
            sessionsVM.sessions = updated
        }
        .onReceive(client.$hosts) { updated in
            sessionsVM.hosts = updated
        }
        // Auto-save layout when panes change (debounced via task)
        .onChange(of: panes.map { $0.id }) { _ in
            autoSaveWorkspace()
        }
        .sheet(isPresented: $showCommandPalette) {
            CommandPaletteView(
                isPresented: $showCommandPalette,
                sessions: sessionsVM.sessions
            ) { session in
                openSessionInNewPane(session)
            }
        }
        .sheet(isPresented: $showHosts) {
            HostManagementView(sessionsVM: sessionsVM, isPresented: $showHosts)
        }
        .sheet(isPresented: $showWorkspaces) {
            WorkspaceSwitcherView(
                workspaceVM: workspaceVM,
                currentPanes: panes,
                isPresented: $showWorkspaces,
                onRestore: { wsId in
                    if let restored = workspaceVM.restore(id: wsId) {
                        panes = restored
                        activeWorkspaceId = wsId
                    }
                },
                onSaveNew: { name in
                    let id = UUID().uuidString
                    workspaceVM.save(id: id, name: name, panes: panes)
                    activeWorkspaceId = id
                }
            )
        }
        // Cmd+K command palette
        .background(
            Button("") { showCommandPalette.toggle() }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0)
        )
    }

    // MARK: - Pane management

    private func openSessionInNewPane(_ session: SigilSession) {
        let tab = Tab(hostName: session.hostName, sessionName: session.name, sessionId: session.id)
        panes.append(Pane(tabs: [tab]))
    }

    private func openSessionInFocusedPane(_ session: SigilSession) {
        let tab = Tab(hostName: session.hostName, sessionName: session.name, sessionId: session.id)
        if panes.isEmpty {
            panes.append(Pane(tabs: [tab]))
        } else {
            panes[panes.count - 1].tabs.append(tab)
            panes[panes.count - 1].activeTabIdx = panes[panes.count - 1].tabs.count - 1
        }
    }

    private func closePane(_ paneId: String) {
        panes.removeAll { $0.id == paneId }
    }

    private func autoSaveWorkspace() {
        let wsId = activeWorkspaceId ?? {
            let id = workspaceVM.createDefault()
            activeWorkspaceId = id
            return id
        }()
        let name = workspaceVM.workspaces.first(where: { $0.id == wsId })?.name ?? "Default"
        workspaceVM.save(id: wsId, name: name, panes: panes)
    }
}

// MARK: - Workspace switcher sheet

struct WorkspaceSwitcherView: View {
    @ObservedObject var workspaceVM: WorkspaceViewModel
    let currentPanes: [MainView.Pane]
    @Binding var isPresented: Bool
    let onRestore: (String) -> Void
    let onSaveNew: (String) -> Void

    @State private var newName = ""
    @State private var showNewField = false

    var body: some View {
        NavigationStack {
            List {
                Section("Saved Layouts") {
                    if workspaceVM.workspaces.isEmpty {
                        Text("No saved workspaces")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(workspaceVM.workspaces) { ws in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(ws.name)
                                        .font(.system(.body, design: .monospaced))
                                    Text("\(ws.panes.count) pane\(ws.panes.count == 1 ? "" : "s")")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if workspaceVM.activeWorkspaceId == ws.id {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.accentColor)
                                        .font(.caption)
                                }
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                onRestore(ws.id)
                                isPresented = false
                            }
                            .swipeActions(edge: .trailing) {
                                Button("Delete", role: .destructive) {
                                    workspaceVM.delete(id: ws.id)
                                }
                            }
                        }
                    }
                }

                Section("Save Current Layout") {
                    if showNewField {
                        HStack {
                            TextField("Workspace name", text: $newName)
                            #if os(iOS)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.words)
                            #endif
                            Button("Save") {
                                guard !newName.isEmpty else { return }
                                onSaveNew(newName)
                                newName = ""
                                showNewField = false
                            }
                            .disabled(newName.isEmpty)
                        }
                    } else {
                        Button {
                            showNewField = true
                        } label: {
                            Label("Save as New Workspace…", systemImage: "plus")
                        }
                    }

                    if let wsId = workspaceVM.activeWorkspaceId,
                       let ws = workspaceVM.workspaces.first(where: { $0.id == wsId }) {
                        Button {
                            workspaceVM.save(id: wsId, name: ws.name, panes: currentPanes)
                            isPresented = false
                        } label: {
                            Label("Update "\(ws.name)"", systemImage: "square.and.arrow.down")
                        }
                    }
                }
            }
            .navigationTitle("Workspaces")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { isPresented = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Pane grid

struct PaneGridView: View {
    @Binding var panes: [MainView.Pane]
    let client: SigilClient
    let onClosePane: (String) -> Void

    var body: some View {
        if panes.isEmpty {
            VStack(spacing: 12) {
                Text("Sigil")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.secondary)
                Text("Select a session from the sidebar")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let cols = panes.count == 1 ? 1 : 2
            ScrollView {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: cols),
                    spacing: 2
                ) {
                    ForEach($panes) { $pane in
                        PaneView(pane: $pane, client: client) {
                            onClosePane(pane.id)
                        }
                        .aspectRatio(16 / 9, contentMode: .fit)
                    }
                }
                .padding(2)
            }
        }
    }
}

// MARK: - Single pane with tab bar

struct PaneView: View {
    @Binding var pane: MainView.Pane
    let client: SigilClient
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            if pane.tabs.count > 1 {
                tabBar
            }
            if let tab = pane.activeTab {
                TerminalTileView(
                    client: client,
                    hostName: tab.hostName,
                    sessionName: tab.sessionName,
                    sessionId: tab.sessionId
                )
                .id(tab.id)
            }
        }
        .overlay(alignment: .topTrailing) {
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
                    .padding(4)
            }
            .buttonStyle(.plain)
        }
    }

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(Array(pane.tabs.enumerated()), id: \.element.id) { idx, tab in
                    Button {
                        pane.activeTabIdx = idx
                    } label: {
                        HStack(spacing: 5) {
                            Text("\(tab.hostName)/\(tab.sessionName)")
                                .font(.system(size: 11, design: .monospaced))
                                .lineLimit(1)
                            Button {
                                closeTab(at: idx)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 9, weight: .medium))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(
                            idx == pane.activeTabIdx
                                ? Color(red: 0.1, green: 0.1, blue: 0.13)
                                : Color(red: 0.06, green: 0.06, blue: 0.08)
                        )
                        .foregroundStyle(idx == pane.activeTabIdx ? .primary : .secondary)
                    }
                    .buttonStyle(.plain)

                    Divider().frame(height: 20)
                }
            }
        }
        .background(Color(red: 0.06, green: 0.06, blue: 0.08))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color(red: 0.15, green: 0.15, blue: 0.2))
                .frame(height: 1)
        }
    }

    private func closeTab(at idx: Int) {
        guard pane.tabs.indices.contains(idx) else { return }
        pane.tabs.remove(at: idx)
        if pane.tabs.isEmpty {
            onClose()
        } else {
            pane.activeTabIdx = max(0, min(pane.activeTabIdx, pane.tabs.count - 1))
        }
    }
}
