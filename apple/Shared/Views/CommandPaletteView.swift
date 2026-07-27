import SwiftUI

struct CommandPaletteView: View {
    @Binding var isPresented: Bool
    let sessions: [SigilSession]
    let onSelect: (SigilSession) -> Void

    @State private var query = ""
    @State private var selectedIndex = 0

    var filtered: [SigilSession] {
        if query.isEmpty { return sessions }
        return sessions.filter {
            $0.name.localizedCaseInsensitiveContains(query) ||
            $0.hostName.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search sessions...", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(.body, design: .monospaced))
                if !query.isEmpty {
                    Button {
                        query = ""
                        selectedIndex = 0
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(filtered.enumerated()), id: \.element.id) { i, session in
                        HStack(spacing: 4) {
                            Text(session.hostName)
                                .foregroundStyle(.secondary)
                                .font(.caption)
                            Text("/")
                                .foregroundStyle(.secondary)
                                .font(.caption)
                            Text(session.name)
                                .font(.system(.body, design: .monospaced))
                            Spacer()
                            Text(session.status)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(i == selectedIndex ? Color.accentColor.opacity(0.2) : Color.clear)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            onSelect(session)
                            isPresented = false
                        }
                        .onHover { hovering in
                            if hovering { selectedIndex = i }
                        }
                    }

                    if filtered.isEmpty {
                        Text("No sessions found")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                            .padding(16)
                    }
                }
            }
        }
        .frame(width: 500, height: 400)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(radius: 20)
    }
}
