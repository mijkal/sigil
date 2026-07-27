import SwiftUI

struct TerminalTileView: View {
    let client: SigilClient
    let hostName: String
    let sessionName: String
    let sessionId: String

    @EnvironmentObject private var settings: TerminalSettings
    @StateObject private var channelVM: ChannelViewModel
    @StateObject private var scrollbackVM: ScrollbackViewModel

    @State private var detectedURLs: [String] = []
    @State private var urlFooterIdx: Int = 0
    @State private var urlCopied: Bool = false

    init(client: SigilClient, hostName: String, sessionName: String, sessionId: String) {
        self.client = client
        self.hostName = hostName
        self.sessionName = sessionName
        self.sessionId = sessionId
        _channelVM = StateObject(wrappedValue: ChannelViewModel(
            client: client,
            hostName: hostName,
            sessionName: sessionName,
            sessionId: sessionId
        ))
        _scrollbackVM = StateObject(wrappedValue: ScrollbackViewModel(
            client: client,
            sessionId: sessionId
        ))
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                titleBar
                ZStack(alignment: .bottom) {
                    SigilTerminalView(
                        channelVM: channelVM,
                        fontSize: settings.fontSize,
                        onLinkDetected: addURL
                    )
                    .background(Color(red: 0.04, green: 0.04, blue: 0.047))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                    if !detectedURLs.isEmpty {
                        urlFooter
                    }
                }
            }

            if scrollbackVM.isVisible {
                ScrollbackView(vm: scrollbackVM, fontSize: settings.fontSize)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .task { await channelVM.attach(rows: 24, cols: 80) }
        .onDisappear { Task { await channelVM.detach() } }
        .animation(.easeInOut(duration: 0.22), value: scrollbackVM.isVisible)
    }

    // MARK: - Title bar

    private var titleBar: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(channelVM.isAttached ? Color.green : Color.gray)
                .frame(width: 6, height: 6)
            Text("\(hostName) / \(sessionName)")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Spacer()

            // Font size
            Button { settings.decrease() } label: {
                Image(systemName: "minus")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            Text("\(Int(settings.fontSize))")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(minWidth: 18, alignment: .center)
            Button { settings.increase() } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)

            // Scrollback history
            Button { scrollbackVM.open() } label: {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("View scrollback history")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(red: 0.07, green: 0.075, blue: 0.094))
    }

    // MARK: - URL footer bar

    private var urlFooter: some View {
        let idx = min(urlFooterIdx, detectedURLs.count - 1)
        let url = detectedURLs[idx]
        return urlFooterRow(url: url, idx: idx, total: detectedURLs.count)
    }

    private func urlFooterRow(url: String, idx: Int, total: Int) -> some View {
        HStack(spacing: 0) {
            Text("⎘")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Color(red: 0.39, green: 0.4, blue: 0.94))
                .padding(.horizontal, 7)

            Text(url)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)

            if total > 1 {
                Button {
                    urlFooterIdx = (idx - 1 + total) % total
                } label: {
                    Text("‹").font(.system(size: 14, weight: .medium))
                }
                .buttonStyle(.plain).foregroundStyle(.secondary).padding(.horizontal, 4)

                Text("\(idx + 1)/\(total)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)

                Button {
                    urlFooterIdx = (idx + 1) % total
                } label: {
                    Text("›").font(.system(size: 14, weight: .medium))
                }
                .buttonStyle(.plain).foregroundStyle(.secondary).padding(.horizontal, 4)
            }

            Button { copyURL(url) } label: {
                Text(urlCopied ? "✓ copied" : "⎘ copy")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(urlCopied ? .green : Color(red: 0.51, green: 0.51, blue: 0.94))
                    .padding(.horizontal, 8)
            }
            .buttonStyle(.plain)

            Button { openURL(url) } label: {
                Text("↗")
                    .font(.system(size: 12))
                    .foregroundStyle(Color(red: 0.13, green: 0.83, blue: 0.83))
                    .padding(.horizontal, 6)
            }
            .buttonStyle(.plain)

            Button { detectedURLs = []; urlFooterIdx = 0 } label: {
                Text("✕")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 2)
        .background(Color(red: 0.04, green: 0.04, blue: 0.07).opacity(0.95))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color(red: 0.12, green: 0.12, blue: 0.17))
                .frame(height: 1)
        }
    }

    // MARK: - Helpers

    private func addURL(_ url: String) {
        if let existing = detectedURLs.firstIndex(where: { url.hasPrefix($0) || $0.hasPrefix(url) }) {
            if url.count > detectedURLs[existing].count {
                detectedURLs[existing] = url
            }
        } else {
            detectedURLs.append(url)
            if detectedURLs.count > 20 { detectedURLs.removeFirst() }
        }
    }

    private func copyURL(_ url: String) {
        #if os(iOS)
        UIPasteboard.general.string = url
        #elseif os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
        #endif
        urlCopied = true
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            urlCopied = false
        }
    }

    private func openURL(_ url: String) {
        guard let u = URL(string: url) else { return }
        #if os(iOS)
        UIApplication.shared.open(u)
        #elseif os(macOS)
        NSWorkspace.shared.open(u)
        #endif
    }
}
