import SwiftUI

@main
struct SigilApp: App {
    @StateObject private var appVM = AppViewModel()
    @StateObject private var terminalSettings = TerminalSettings()

    var body: some Scene {
        #if os(macOS)
        WindowGroup {
            ContentView()
                .environmentObject(appVM)
                .environmentObject(terminalSettings)
                .frame(minWidth: 900, minHeight: 600)
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
        #else
        WindowGroup {
            ContentView()
                .environmentObject(appVM)
                .environmentObject(terminalSettings)
        }
        #endif
    }
}
