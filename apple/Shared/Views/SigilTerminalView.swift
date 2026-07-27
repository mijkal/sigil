import SwiftUI
import SwiftTerm

#if os(macOS)
struct SigilTerminalView: NSViewRepresentable {
    @ObservedObject var channelVM: ChannelViewModel
    var fontSize: CGFloat
    var onLinkDetected: ((String) -> Void)?

    func makeNSView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: .zero)
        tv.delegate = context.coordinator
        applyTheme(to: tv)
        channelVM.outputHandler = { data in
            DispatchQueue.main.async { tv.feed(byteArray: [UInt8](data)) }
        }
        return tv
    }

    func updateNSView(_ tv: TerminalView, context: Context) {
        if tv.font.pointSize != fontSize {
            tv.font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        }
        context.coordinator.onLinkDetected = onLinkDetected
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(channelVM: channelVM, onLinkDetected: onLinkDetected)
    }

    private func applyTheme(to tv: TerminalView) {
        tv.font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        tv.nativeBackgroundColor = NSColor(red: 0.04,  green: 0.04,  blue: 0.047, alpha: 1)
        tv.nativeForegroundColor = NSColor(red: 0.886, green: 0.91,  blue: 0.941, alpha: 1)
    }

    class Coordinator: NSObject, TerminalViewDelegate {
        let channelVM: ChannelViewModel
        var onLinkDetected: ((String) -> Void)?

        init(channelVM: ChannelViewModel, onLinkDetected: ((String) -> Void)?) {
            self.channelVM = channelVM
            self.onLinkDetected = onLinkDetected
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            channelVM.sendInput(Data(data))
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            channelVM.resize(rows: newRows, cols: newCols)
        }

        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            onLinkDetected?(link)
            if let url = URL(string: link) { NSWorkspace.shared.open(url) }
        }

        func scrolled(source: TerminalView, position: Double) {}
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func iTermContent(source: TerminalView, content: Data) {}
    }
}
#endif

#if os(iOS)
struct SigilTerminalView: UIViewRepresentable {
    @ObservedObject var channelVM: ChannelViewModel
    var fontSize: CGFloat
    var onLinkDetected: ((String) -> Void)?

    func makeUIView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: .zero)
        tv.delegate = context.coordinator
        applyTheme(to: tv)
        channelVM.outputHandler = { data in
            DispatchQueue.main.async { tv.feed(byteArray: [UInt8](data)) }
        }
        return tv
    }

    func updateUIView(_ tv: TerminalView, context: Context) {
        if tv.font.pointSize != fontSize {
            tv.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        }
        context.coordinator.onLinkDetected = onLinkDetected
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(channelVM: channelVM, onLinkDetected: onLinkDetected)
    }

    private func applyTheme(to tv: TerminalView) {
        tv.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        tv.nativeBackgroundColor = UIColor(red: 0.04,  green: 0.04,  blue: 0.047, alpha: 1)
        tv.nativeForegroundColor = UIColor(red: 0.886, green: 0.91,  blue: 0.941, alpha: 1)
    }

    class Coordinator: NSObject, TerminalViewDelegate {
        let channelVM: ChannelViewModel
        var onLinkDetected: ((String) -> Void)?

        init(channelVM: ChannelViewModel, onLinkDetected: ((String) -> Void)?) {
            self.channelVM = channelVM
            self.onLinkDetected = onLinkDetected
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            channelVM.sendInput(Data(data))
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            channelVM.resize(rows: newRows, cols: newCols)
        }

        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            onLinkDetected?(link)
            if let url = URL(string: link) { UIApplication.shared.open(url) }
        }

        func scrolled(source: TerminalView, position: Double) {}
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func iTermContent(source: TerminalView, content: Data) {}
    }
}
#endif
