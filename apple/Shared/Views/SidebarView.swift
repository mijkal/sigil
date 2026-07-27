import SwiftUI

struct SidebarView: View {
    @ObservedObject var sessionsVM: SessionsViewModel
    let onOpen: (SigilSession) -> Void         // open in new pane
    let onOpenInPane: (SigilSession) -> Void   // open as tab in focused pane

    @State private var renameSession: SigilSession?
    @State private var renameText = ""
    @State private var showNewSession = false
    @State private var newSessionHost = ""
    @State private var newSessionName = ""

    var body: some View {
        List {
            ForEach(sessionsVM.hosts) { host in
                Section(host.name) {
                    let hostSessions = sessionsVM.sessions.filter { $0.hostName == host.name }
                    if hostSessions.isEmpty {
                        Text("No sessions")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    } else {
                        ForEach(hostSessions) { session in
                            SessionRow(session: session)
                                .contentShape(Rectangle())
                                .onTapGesture { onOpen(session) }
                                .contextMenu {
                                    Button("Open in New Pane") { onOpen(session) }
                                    Button("Open as Tab") { onOpenInPane(session) }
                                    Divider()
                                    Button("Rename…") {
                                        renameText = session.name
                                        renameSession = session
                                    }
                                    Button("Delete", role: .destructive) {
                                        Task { await sessionsVM.deleteSession(id: session.id) }
                                    }
                                }
                        }
                    }
                }
            }

            if sessionsVM.hosts.isEmpty {
                Text("No hosts connected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Sigil")
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    Task { await sessionsVM.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Refresh")
            }
            ToolbarItem(placement: .automatic) {
                Button { showNewSession = true } label: {
                    Image(systemName: "plus")
                }
                .help("New Session")
            }
        }
        .refreshable { await sessionsVM.refresh() }
        // Rename alert
        .alert("Rename Session", isPresented: Binding(
            get: { renameSession != nil },
            set: { if !$0 { renameSession = nil } }
        )) {
            TextField("Session name", text: $renameText)
            #if os(iOS)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            #endif
            Button("Rename") {
                if let s = renameSession, !renameText.isEmpty {
                    Task { await sessionsVM.renameSession(id: s.id, newName: renameText) }
                }
                renameSession = nil
            }
            Button("Cancel", role: .cancel) { renameSession = nil }
        }
        // New session sheet
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet(
                hosts: sessionsVM.hosts,
                hostText: $newSessionHost,
                nameText: $newSessionName,
                isPresented: $showNewSession
            ) { host, name in
                Task { await sessionsVM.createSession(hostName: host, name: name) }
            }
        }
        .overlay {
            if let err = sessionsVM.error {
                VStack {
                    Spacer()
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(8)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                        .padding()
                }
            }
        }
    }
}

// MARK: - Session row

struct SessionRow: View {
    let session: SigilSession

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(session.status == "active" ? Color.green : Color.gray)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.name)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                Text(session.hostName)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Text("\(session.windows)w")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.quaternary)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - New session sheet

struct NewSessionSheet: View {
    let hosts: [SigilHost]
    @Binding var hostText: String
    @Binding var nameText: String
    @Binding var isPresented: Bool
    let onCreate: (String, String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Host") {
                    if hosts.isEmpty {
                        TextField("Host name", text: $hostText)
                            #if os(iOS)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            #endif
                    } else {
                        Picker("Host", selection: $hostText) {
                            ForEach(hosts) { host in
                                Text(host.name).tag(host.name)
                            }
                        }
                        .onAppear {
                            if hostText.isEmpty, let first = hosts.first {
                                hostText = first.name
                            }
                        }
                    }
                }
                Section("Session name") {
                    TextField("e.g. main", text: $nameText)
                        #if os(iOS)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        #endif
                }
            }
            .navigationTitle("New Session")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        guard !hostText.isEmpty, !nameText.isEmpty else { return }
                        onCreate(hostText, nameText)
                        nameText = ""
                        isPresented = false
                    }
                    .disabled(hostText.isEmpty || nameText.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
