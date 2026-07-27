import Foundation

/// Shared terminal appearance settings — injected as an EnvironmentObject from SigilApp.
@MainActor
final class TerminalSettings: ObservableObject {
    static let minSize: CGFloat = 9
    static let maxSize: CGFloat = 24

    @Published var fontSize: CGFloat = 13

    func increase() { fontSize = min(fontSize + 1, Self.maxSize) }
    func decrease() { fontSize = max(fontSize - 1, Self.minSize) }
}
