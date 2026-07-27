import SwiftUI

struct SetupView: View {
    @EnvironmentObject var appVM: AppViewModel
    @State private var url = ""
    @State private var token = ""

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Text("Sigil")
                .font(.system(size: 48, weight: .bold, design: .monospaced))

            Text("Terminal Session Manager")
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                Text("Hub URL")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("http://the hub host.lan:7777", text: $url)
                    .textFieldStyle(.roundedBorder)
                #if os(iOS)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                #endif

                Text("Auth Token")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                SecureField("token", text: $token)
                    .textFieldStyle(.roundedBorder)
            }
            .frame(maxWidth: 400)

            Button("Connect") {
                appVM.hubURL = url
                appVM.authToken = token
                appVM.setupClient()
            }
            .buttonStyle(.borderedProminent)
            .disabled(url.isEmpty || token.isEmpty)

            Spacer()
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            url = appVM.hubURL
            token = appVM.authToken
        }
    }
}
