import SwiftUI

struct ContentView: View {
    @EnvironmentObject var appVM: AppViewModel

    var body: some View {
        if appVM.isConfigured, let client = appVM.client {
            MainView(client: client)
        } else {
            SetupView()
        }
    }
}
