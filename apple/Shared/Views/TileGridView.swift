import SwiftUI

struct TileGridView: View {
    let tiles: [MainView.TileItem]
    let client: SigilClient
    let onClose: (String) -> Void

    var body: some View {
        if tiles.isEmpty {
            VStack(spacing: 12) {
                Text("Sigil")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.secondary)
                Text("Select a session from the sidebar")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let cols = tiles.count == 1 ? 1 : 2
            ScrollView {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: cols),
                    spacing: 2
                ) {
                    ForEach(tiles) { tile in
                        TerminalTileView(
                            client: client,
                            hostName: tile.hostName,
                            sessionName: tile.sessionName,
                            sessionId: tile.sessionId
                        )
                        .overlay(alignment: .topTrailing) {
                            Button {
                                onClose(tile.id)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                                    .padding(4)
                            }
                            .buttonStyle(.plain)
                        }
                        .aspectRatio(16 / 9, contentMode: .fit)
                    }
                }
                .padding(2)
            }
        }
    }
}
