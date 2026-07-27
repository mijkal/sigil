import SwiftUI
import SwiftTerm

// MARK: - Overlay View

struct ScrollbackView: View {
    @ObservedObject var vm: ScrollbackViewModel
    let fontSize: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(red: 0.04, green: 0.04, blue: 0.047).ignoresSafeArea()
            VStack(spacing: 0) {
                header
                Divider().overlay(Color(red: 0.18, green: 0.18, blue: 0.21))
                if vm.isLoading {
                    Spacer()
                    ProgressView()
                    Spacer()
                } else if let err = vm.errorMessage {
                    Spacer()
                    Text(err)
                        .font(.caption.monospaced())
                        .foregroundStyle(.red)
                        .padding()
                    Spacer()
                } else {
                    ScrollbackTerminalView(chunks: vm.chunks, fontSize: fontSize)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .gesture(
            DragGesture().onEnded { value in
                if value.translation.height > 60 { vm.close() }
            }
        )
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("SCROLLBACK")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color(red: 0.51, green: 0.51, blue: 0.94))
                .kerning(0.8)
            if vm.isLoading {
                ProgressView().scaleEffect(0.65)
            }
            Spacer()
            Text("swipe ↓ · esc to close")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
            Button {
                vm.close()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Color(red: 0.08, green: 0.08, blue: 0.1))
    }
}

// MARK: - Alt-screen filter
// Strips alternate-screen enter/exit sequences before feeding historical data,
// mirroring the web client's filterAltScreen() function.

private func filterAltScreen(_ bytes: [UInt8]) -> [UInt8] {
    guard let str = String(bytes: bytes, encoding: .utf8) else { return bytes }
    let filtered = str
        .replacingOccurrences(of: "\u{1b}[?1049h", with: "")
        .replacingOccurrences(of: "\u{1b}[?1049l", with: "")
        .replacingOccurrences(of: "\u{1b}[?47h",   with: "")
        .replacingOccurrences(of: "\u{1b}[?47l",   with: "")
        .replacingOccurrences(of: "\u{1b}[?1047h", with: "")
        .replacingOccurrences(of: "\u{1b}[?1047l", with: "")
    return Array(filtered.utf8)
}

// MARK: - Read-only terminal (platform split)

#if os(macOS)
struct ScrollbackTerminalView: NSViewRepresentable {
    let chunks: [ScrollbackChunk]
    let fontSize: CGFloat

    func makeNSView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: .zero)
        tv.nativeBackgroundColor = NSColor(red: 0.04, green: 0.04, blue: 0.047, alpha: 1)
        tv.nativeForegroundColor = NSColor(red: 0.886, green: 0.91, blue: 0.941, alpha: 1)
        tv.font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        return tv
    }

    func updateNSView(_ tv: TerminalView, context: Context) {
        guard !context.coordinator.fed, !chunks.isEmpty else { return }
        context.coordinator.fed = true
        let bytes = collectBytes()
        DispatchQueue.main.async { tv.feed(byteArray: bytes) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    private func collectBytes() -> [UInt8] {
        chunks.flatMap { chunk -> [UInt8] in
            guard let data = Data(base64Encoded: chunk.data) else { return [] }
            return filterAltScreen([UInt8](data))
        }
    }

    class Coordinator: NSObject { var fed = false }
}
#endif

#if os(iOS)
struct ScrollbackTerminalView: UIViewRepresentable {
    let chunks: [ScrollbackChunk]
    let fontSize: CGFloat

    func makeUIView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: .zero)
        tv.nativeBackgroundColor = UIColor(red: 0.04, green: 0.04, blue: 0.047, alpha: 1)
        tv.nativeForegroundColor = UIColor(red: 0.886, green: 0.91, blue: 0.941, alpha: 1)
        tv.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        return tv
    }

    func updateUIView(_ tv: TerminalView, context: Context) {
        guard !context.coordinator.fed, !chunks.isEmpty else { return }
        context.coordinator.fed = true
        let bytes = collectBytes()
        DispatchQueue.main.async { tv.feed(byteArray: bytes) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    private func collectBytes() -> [UInt8] {
        chunks.flatMap { chunk -> [UInt8] in
            guard let data = Data(base64Encoded: chunk.data) else { return [] }
            return filterAltScreen([UInt8](data))
        }
    }

    class Coordinator: NSObject { var fed = false }
}
#endif
