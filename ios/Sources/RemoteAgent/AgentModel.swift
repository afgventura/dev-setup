import Combine
import Foundation
import Security

struct AgentMessage: Identifiable { let id: String; let role: String; let text: String; let streaming: Bool }
struct AgentQuestion { let id: String; let kind: String; let title: String; let message: String?; let options: [String]?; let placeholder: String?; let prefill: String? }
struct AgentSession { let id: String; var title: String; var state: String; var messages: [AgentMessage]; var question: AgentQuestion? }

enum KeychainStore {
    private static func query() -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: "remote-agent-relay-token"] }
    static func read() -> String? { var result: CFTypeRef?; guard SecItemCopyMatching(query().merging([kSecReturnData as String: true]) { $1 } as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }; return String(data: data, encoding: .utf8) }
    static func write(_ value: String) { SecItemDelete(query() as CFDictionary); SecItemAdd(query().merging([kSecValueData as String: Data(value.utf8)]) { $1 } as CFDictionary, nil) }
}

@MainActor final class AgentModel: ObservableObject {
    @Published var sessions: [AgentSession] = []
    @Published var connectionState = "not configured"
    private var socket: URLSessionWebSocketTask?
    private var connectTask: Task<Void, Never>?
    private var cursors: [String: Int] = [:]
    private var generation = 0
    private var terminalFailure = false
    private var token: String { KeychainStore.read() ?? "" }
    private var relayURL: URL? { URL(string: UserDefaults.standard.string(forKey: "relayURL") ?? "ws://127.0.0.1:8765") }

    init() {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--pi-review-fixture") {
            connectionState = "connected"
            sessions = [
                AgentSession(id: "pi-review", title: "haloai / pi-ios-ui", state: "waitingForInput", messages: [
                    AgentMessage(id: "review-1", role: "user", text: "Make the session list feel calmer and easier to scan.", streaming: false),
                    AgentMessage(id: "review-2", role: "assistant", text: "I found the session navigation and tightened the hierarchy. The new layout keeps the active Pi state visible while leaving implementation details out of the conversation.", streaming: false),
                    AgentMessage(id: "review-3", role: "assistant", text: "I’m ready to apply the change.\n\n```swift\nlet accent = Color.indigo\n```", streaming: false)
                ], question: AgentQuestion(id: "review-question", kind: "choice", title: "Apply the interface update?", message: "Pi has prepared the next step for this workspace.", options: ["Apply changes", "Review first"], placeholder: nil, prefill: nil))]
        }
#endif
    }

    func configure(url: String, token: String) {
        generation += 1
        terminalFailure = false
        UserDefaults.standard.set(url, forKey: "relayURL")
        KeychainStore.write(token)
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connectTask?.cancel()
        let current = generation
        connectTask = Task { await connect(generation: current) }
    }
    func connect() async {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--pi-review-fixture") { return }
#endif
        await connect(generation: generation)
    }
    private func connect(generation current: Int) async {
        guard current == generation else { return }
        guard socket == nil else { return }
        guard !terminalFailure else { return }
        guard !token.isEmpty else { connectionState = "not configured"; return }
        guard let url = relayURL, ["ws", "wss"].contains(url.scheme), url.host != nil else { connectionState = "invalid relay URL"; return }
        connectionState = "connecting"
        let request = URLRequest(url: url)
        socket = URLSession.shared.webSocketTask(with: request)
        socket?.resume()
        send(["type": "authenticate", "token": token, "role": "app"])
        await receiveLoop(generation: current)
    }
    private func receiveLoop(generation current: Int) async {
        var delay: UInt64 = 1
        while let socket, !Task.isCancelled {
            do {
                let result = try await socket.receive()
                if case .string(let text) = result, let data = text.data(using: .utf8) { apply(data) }
                delay = 1
            } catch {
                if current != generation { return }
                self.socket = nil
                if terminalFailure { return }
                connectionState = "reconnecting"
                try? await Task.sleep(for: .seconds(delay))
                delay = min(delay * 2, 15)
                if !Task.isCancelled { await connect(generation: current) }
                return
            }
        }
    }
    func prompt(_ id: String, text: String) { send(["type": "prompt", "sessionId": id, "message": text, "requestId": UUID().uuidString]) }
    func steer(_ id: String, text: String) { send(["type": "steer", "sessionId": id, "message": text, "requestId": UUID().uuidString]) }
    func followUp(_ id: String, text: String) { send(["type": "follow_up", "sessionId": id, "message": text, "requestId": UUID().uuidString]) }
    func abort(_ id: String) { send(["type": "abort", "sessionId": id, "requestId": UUID().uuidString]) }
    func answer(_ id: String, questionId: String, answer: [String: Any]) { if let index = sessions.firstIndex(where: { $0.id == id }) { sessions[index].question = nil }; send(["type": "answer", "sessionId": id, "questionId": questionId, "answer": answer]) }
    private func send(_ object: [String: Any]) { guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }; socket?.send(.string(text)) { _ in } }

    private func apply(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = object["type"] as? String else { return }
        if type == "authenticated" { connectionState = "connected"; send(["type": "list_sessions"]); return }
        if type == "error" { let code = object["code"] as? String; connectionState = code == "unauthorized" ? "unauthorized" : (object["message"] as? String ?? "error"); terminalFailure = code == "unauthorized"; if terminalFailure { socket?.cancel(with: .protocolError, reason: nil) }; return }
        if type == "sessions", let rows = object["sessions"] as? [[String: Any]] { for row in rows { if let id = row["sessionId"] as? String { ensureSession(id); send(["type": "subscribe", "sessionId": id]) } }; return }
        guard let id = object["sessionId"] as? String else { return }
        let sequence = object["sequence"] as? Int ?? 0
        if sequence > 0, sequence <= (cursors[id] ?? 0) { return }
        if sequence > 0 { cursors[id] = sequence; send(["type": "ack", "sessionId": id, "sequence": sequence]) }
        if type == "snapshot", let events = object["events"] as? [[String: Any]] { for event in events { applyEvent(event, sessionId: id) }; return }
        applyEvent(object, sessionId: id)
    }
    private func ensureSession(_ id: String) { if !sessions.contains(where: { $0.id == id }) { sessions.append(AgentSession(id: id, title: id, state: "disconnected", messages: [], question: nil)) } }
    private func applyEvent(_ object: [String: Any], sessionId: String) {
        ensureSession(sessionId); guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }; var item = sessions[index]
        switch object["type"] as? String {
        case "state": item.state = object["state"] as? String ?? item.state
        case "message":
            guard let text = object["text"] as? String else { break }; let messageId = object["messageId"] as? String ?? UUID().uuidString; let streaming = object["streaming"] as? Bool ?? false
            if let existing = item.messages.firstIndex(where: { $0.id == messageId }) { let old = item.messages[existing]; let nextText = object["delta"] as? Bool == true ? old.text + text : text; item.messages[existing] = AgentMessage(id: messageId, role: old.role, text: nextText, streaming: streaming) } else { item.messages.append(AgentMessage(id: messageId, role: object["role"] as? String ?? "assistant", text: text, streaming: streaming)) }
        case "question":
            item.state = "waitingForInput"; item.question = AgentQuestion(id: object["questionId"] as? String ?? "", kind: object["kind"] as? String ?? "input", title: object["title"] as? String ?? "Pi asks", message: object["message"] as? String, options: object["options"] as? [String], placeholder: object["placeholder"] as? String, prefill: object["prefill"] as? String)
        case "question_resolved": item.question = nil; item.state = "running"
        default: break
        }
        sessions[index] = item
    }
}
