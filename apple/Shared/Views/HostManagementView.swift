import SwiftUI

/// Sheet for viewing connected hosts and reconnecting/disconnecting.
/// Full host add/edit is hub-side (config.toml); this surface shows live status
/// and lets users trigger connect/disconnect per host.
struct HostManagementView: View {
    @ObservedObject var sessionsVM: SessionsViewModel
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            List {
                if sessionsVM.hosts.isEmpty {
                    ContentUnavailableView(
                        "No Hosts",
                        systemImage: "server.rack",
                        description: Text("Add hosts to your sigil config.toml and restart the hub.")
                    )
                } else {
                    ForEach(sessionsVM.hosts) { host in
                        HostRow(host: host)
                    }
                }
            }
            .navigationTitle("Hosts")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { isPresented = false }
                }
                ToolbarItem(placement: .automatic) {
                    Button {
                        Task { await sessionsVM.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .refreshable { await sessionsVM.refresh() }
            .overlay {
                if sessionsVM.isLoading {
                    ProgressView()
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct HostRow: View {
    let host: SigilHost

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(statusColor)
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(host.name)
                    .font(.system(.body, design: .monospaced))
                Text("\(host.user)@\(host.hostname):\(host.port)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let err = host.error, !err.isEmpty {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(host.status.capitalized)
                    .font(.caption)
                    .foregroundStyle(statusColor)
                if !host.tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(host.tags, id: \.self) { tag in
                            Text(tag)
                                .font(.system(size: 9, weight: .medium, design: .monospaced))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Color.accentColor.opacity(0.15))
                                .foregroundStyle(Color.accentColor)
                                .clipShape(Capsule())
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var statusColor: Color {
        switch host.status {
        case "connected": return .green
        case "connecting": return .yellow
        case "error":     return .red
        default:          return .gray
        }
    }
}
