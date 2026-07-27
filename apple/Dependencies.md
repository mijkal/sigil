# Sigil Swift Package Dependencies

## Adding Dependencies in Xcode

Open `Sigil.xcodeproj` in Xcode, then go to:
**File > Add Package Dependencies...**

### SwiftTerm
- **URL**: https://github.com/migueldeicaza/SwiftTerm
- **Version**: 1.2.0 (Up to Next Major)
- **Product**: SwiftTerm
- **Purpose**: Terminal emulation (VT100/VT220/xterm). Provides `TerminalView` for both macOS (NSView) and iOS (UIView).

## System Frameworks Used (no SPM needed)

| Framework | Usage |
|-----------|-------|
| Foundation | URLSession, URLSessionWebSocketTask, JSONSerialization, Codable |
| SwiftUI | All UI views |
| Security | Keychain access via SecItemAdd/SecItemCopyMatching/SecItemDelete/SecItemUpdate |

## WebSocket Notes

The app uses `URLSessionWebSocketTask` (available since iOS 13 / macOS 10.15), which is part of Foundation. No external WebSocket library is required.

Protocol:
- Connect to `ws[s]://HOST/ws`
- Authenticate with `{"type":"auth","payload":{"token":"...","client_info":{"type":"apple"}}}`
- Server responds with `{"type":"auth_ok"}` on success
- All binary terminal output is base64-encoded in `channel_output` messages
