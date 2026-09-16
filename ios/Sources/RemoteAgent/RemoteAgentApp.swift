import SwiftUI

@main
struct RemoteAgentApp: App {
    @StateObject private var model = AgentModel()
    var body: some Scene { WindowGroup { ContentView().environmentObject(model) } }
}

private enum PiTheme {
    static let accent = Color(red: 0.38, green: 0.31, blue: 0.92)
    static let canvas = Color.secondary.opacity(0.08)
    static let card = Color.secondary.opacity(0.05)
}

struct ContentView: View {
    @EnvironmentObject private var model: AgentModel
    @AppStorage("relayURL") private var relayURL = "ws://127.0.0.1:8765"
    var body: some View {
        NavigationStack {
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--pi-review-conversation") {
                SessionView(sessionId: "pi-review").environmentObject(model)
            } else {
                SessionListView(relayURL: $relayURL)
            }
#else
            SessionListView(relayURL: $relayURL)
#endif
        }
            .tint(PiTheme.accent)
            .task { await model.connect() }
    }
}

private struct SessionListView: View {
    @EnvironmentObject private var model: AgentModel
    @Binding var relayURL: String
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Your coding sessions").font(.title3.weight(.semibold))
                    Text("Stay close to Pi while it works on your projects.").font(.subheadline).foregroundStyle(.secondary)
                }.padding(.vertical, 8)
                if model.sessions.isEmpty {
                    EmptySessionsView(connectionState: model.connectionState).padding(.top, 42)
                } else {
                    ForEach(model.sessions, id: \.id) { session in
                        NavigationLink { SessionView(sessionId: session.id).environmentObject(model) } label: { SessionRow(session: session) }.buttonStyle(.plain)
                    }
                }
            }.padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 28)
        }
        .background(PiTheme.canvas)
        .navigationTitle("Pi workspace")
        .toolbar { ToolbarItem { NavigationLink { ConnectionView(relayURL: $relayURL).environmentObject(model) } label: { Image(systemName: "slider.horizontal.3").accessibilityLabel("Connection settings") } } }
        .safeAreaInset(edge: .bottom) { ConnectionPill(state: model.connectionState).padding(.horizontal, 18).padding(.bottom, 8) }
    }
}

private struct SessionRow: View {
    let session: AgentSession
    var body: some View {
        HStack(spacing: 14) {
            ZStack { Circle().fill(PiTheme.accent.opacity(0.12)); Image(systemName: "terminal.fill").font(.headline).foregroundStyle(PiTheme.accent) }.frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 5) { Text(session.title).font(.headline).foregroundStyle(.primary).lineLimit(1); StateLabel(state: session.state) }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
        }.padding(16).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous)).overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(.quaternary, lineWidth: 0.6))
    }
}

private struct SessionView: View {
    @EnvironmentObject private var model: AgentModel
    let sessionId: String
    @State private var draft = ""
    @State private var sendMode = "steer"
    private var session: AgentSession { model.sessions.first(where: { $0.id == sessionId }) ?? AgentSession(id: sessionId, title: "Pi session", state: "connecting", messages: [], question: nil) }
    private var isBusy: Bool { ["running", "retrying", "compacting"].contains(session.state) }
    private var canControl: Bool { model.connectionState == "connected" }
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        AgentStatusCard(state: session.state, connectionState: model.connectionState)
                        if session.messages.isEmpty && session.question == nil { ConversationEmptyView() }
                        ForEach(session.messages) { message in MessageBubble(message: message).id(message.id) }
                        if let question = session.question { QuestionCard(question: question) { answer in model.answer(session.id, questionId: question.id, answer: answer) }.id("question-\(question.id)") }
                    }.padding(18).padding(.bottom, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onAppear { DispatchQueue.main.async { if session.question != nil { scrollToQuestion(proxy) } else { scrollToLatest(proxy) } } }
                .onChange(of: session.messages.map(\.text)) { _ in scrollToLatest(proxy) }
                .onChange(of: session.question?.id) { _ in scrollToQuestion(proxy) }
            }
            if isBusy { RunningControls(sendMode: $sendMode, abort: { model.abort(session.id) }, canControl: canControl) }
            Composer(text: $draft, canSend: canControl && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines); draft = ""
                if isBusy && sendMode == "steer" { model.steer(session.id, text: text) } else if isBusy { model.followUp(session.id, text: text) } else { model.prompt(session.id, text: text) }
            }
        }.background(PiTheme.canvas).piConversationNavigationTitle(session.title)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        if let last = session.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
    }

    private func scrollToQuestion(_ proxy: ScrollViewProxy) {
        if let question = session.question { withAnimation { proxy.scrollTo("question-\(question.id)", anchor: .bottom) } }
    }
}

private struct AgentStatusCard: View {
    let state: String; let connectionState: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: state == "waitingForInput" ? "hand.raised.fill" : "sparkles").font(.title3).foregroundStyle(state == "waitingForInput" ? .orange : PiTheme.accent).frame(width: 38, height: 38).background((state == "waitingForInput" ? Color.orange : PiTheme.accent).opacity(0.13), in: Circle())
            VStack(alignment: .leading, spacing: 3) { Text(state == "waitingForInput" ? "Pi needs your input" : stateTitle).font(.headline); Text(connectionState == "connected" ? stateSubtitle : connectionState.capitalized).font(.caption).foregroundStyle(.secondary) }
            Spacer(); if state == "running" { ProgressView().controlSize(.small) }
        }.padding(15).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous)).accessibilityElement(children: .combine).accessibilityLabel("Pi status: \(stateTitle)")
    }
    private var stateTitle: String { switch state { case "running": "Working"; case "compacting": "Organizing context"; case "retrying": "Retrying"; case "reconnecting": "Reconnecting"; case "disconnected": "Ready when you are"; default: "Ready" } }
    private var stateSubtitle: String { state == "running" ? "Pi is working on your request" : "Pi coding agent" }
}

private struct MessageBubble: View {
    let message: AgentMessage
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) { Image(systemName: message.role == "user" ? "person.fill" : "sparkles"); Text(message.role == "user" ? "You" : "Pi").font(.caption.weight(.semibold)); if message.streaming { ProgressView().controlSize(.mini) } }.foregroundStyle(message.role == "user" ? PiTheme.accent : .secondary)
            MarkdownText(text: message.text)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(16).background(message.role == "user" ? PiTheme.accent.opacity(0.10) : PiTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous)).accessibilityElement(children: .combine)
    }
}

private struct MarkdownText: View {
    let text: String
    var body: some View {
        let parts = text.components(separatedBy: "```")
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                if index.isMultiple(of: 2) {
                    if let attributed = try? AttributedString(markdown: part) {
                        Text(attributed).font(.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(part).font(.body).textSelection(.enabled)
                    }
                } else {
                    Text(codeContent(part))
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Color.black.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
        }
    }

    private func codeContent(_ part: String) -> String {
        let trimmed = part.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let newline = trimmed.firstIndex(of: "\n") else { return trimmed }
        let firstLine = String(trimmed[..<newline])
        let isLanguageLabel = firstLine.range(of: "^[A-Za-z0-9_+.-]+$", options: .regularExpression) != nil
        return (isLanguageLabel ? String(trimmed[trimmed.index(after: newline)...]) : trimmed).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private struct QuestionCard: View {
    let question: AgentQuestion; let submit: ([String: Any]) -> Void
    @State private var text: String; @State private var selected = Set<String>(); @State private var submitted = false
    init(question: AgentQuestion, submit: @escaping ([String: Any]) -> Void) { self.question = question; self.submit = submit; _text = State(initialValue: question.prefill ?? "") }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Your decision", systemImage: "hand.raised.fill").font(.subheadline.weight(.bold)).foregroundStyle(.orange)
            Text(question.title).font(.title3.weight(.semibold))
            if let message = question.message { Text(message).font(.body).foregroundStyle(.secondary) }
            options
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous)).overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.orange.opacity(0.35), lineWidth: 1)).accessibilityElement(children: .contain)
    }
    @ViewBuilder private var options: some View {
        if question.kind == "choice", let choices = question.options {
            ForEach(choices, id: \.self) { choice in Button(choice) { send(["value": choice]) }.buttonStyle(.borderedProminent) }
            Button("Cancel") { send(["cancelled": true]) }.foregroundStyle(.secondary)
        } else if question.kind == "multi_select", let choices = question.options {
            ForEach(choices, id: \.self) { choice in Button { selected.toggleMembership(of: choice) } label: { Label(choice, systemImage: selected.contains(choice) ? "checkmark.square.fill" : "square").frame(maxWidth: .infinity, alignment: .leading) }.buttonStyle(.plain).padding(.vertical, 4) }
            actionRow { send(["values": Array(selected)]) }
        } else if question.kind == "confirmation" {
            HStack { Button("Cancel") { send(["cancelled": true]) }; Button("No") { send(["confirmed": false]) }; Button("Yes") { send(["confirmed": true]) }.buttonStyle(.borderedProminent) }
        } else {
            TextField(question.placeholder ?? "Enter a response", text: $text, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(3...6)
            actionRow { send(["value": text]) }
        }
    }
    private func actionRow(submitAction: @escaping () -> Void) -> some View { HStack { Button("Cancel") { send(["cancelled": true]) }; Spacer(); Button("Submit", action: submitAction).buttonStyle(.borderedProminent) } }
    private func send(_ answer: [String: Any]) { guard !submitted else { return }; submitted = true; submit(answer) }
}

private struct RunningControls: View {
    @Binding var sendMode: String; let abort: () -> Void; let canControl: Bool
    var body: some View { VStack(spacing: 8) { Picker("Message behavior", selection: $sendMode) { Text("Steer").tag("steer"); Text("Follow up").tag("follow_up") }.pickerStyle(.segmented); Button("Stop Pi", role: .destructive, action: abort).disabled(!canControl) }.padding(.horizontal, 18).padding(.top, 10) }
}

private struct Composer: View {
    @Binding var text: String; let canSend: Bool; let send: () -> Void
    var body: some View { HStack(alignment: .bottom, spacing: 10) { TextField("Message Pi…", text: $text, axis: .vertical).textFieldStyle(.plain).lineLimit(1...5).padding(.horizontal, 14).padding(.vertical, 11).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous)); Button(action: send) { Image(systemName: "arrow.up").font(.headline).frame(width: 44, height: 44) }.buttonStyle(.borderedProminent).clipShape(Circle()).disabled(!canSend).accessibilityLabel("Send message to Pi") }.padding(.horizontal, 16).padding(.vertical, 10).background(.bar) }
}

private struct StateLabel: View {
    let state: String
    var body: some View { Label(label, systemImage: icon).font(.caption.weight(.medium)).foregroundStyle(color) }
    private var label: String { state == "waitingForInput" ? "Needs your input" : state.capitalized }
    private var icon: String { state == "running" ? "circle.fill" : (state == "waitingForInput" ? "exclamationmark.circle.fill" : "circle") }
    private var color: Color { state == "running" ? .green : (state == "waitingForInput" ? .orange : .secondary) }
}

private struct ConnectionPill: View {
    let state: String
    var body: some View { Label(state.capitalized, systemImage: state == "connected" ? "checkmark.circle.fill" : "bolt.horizontal.circle").font(.caption.weight(.semibold)).foregroundStyle(state == "connected" ? .green : .secondary).padding(.horizontal, 12).padding(.vertical, 8).background(.thinMaterial, in: Capsule()).frame(maxWidth: .infinity, alignment: .leading) }
}

private struct EmptySessionsView: View {
    let connectionState: String
    var body: some View { VStack(spacing: 12) { Image(systemName: "terminal").font(.system(size: 34, weight: .medium)).foregroundStyle(PiTheme.accent); Text("No Pi sessions yet").font(.title3.weight(.semibold)); Text(connectionState == "not configured" ? "Connect this app to your Pi relay to see sessions here." : "When Pi opens a session, it will appear here.").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center) }.frame(maxWidth: .infinity).padding(28) }
}

private struct ConversationEmptyView: View {
    var body: some View { VStack(spacing: 8) { Image(systemName: "text.bubble").font(.title2).foregroundStyle(.secondary); Text("Start a conversation with Pi").font(.headline); Text("Ask Pi to inspect, explain, or change your code.").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center) }.frame(maxWidth: .infinity).padding(.vertical, 58) }
}

private struct ConnectionView: View {
    @EnvironmentObject private var model: AgentModel; @Binding var relayURL: String; @State private var token = KeychainStore.read() ?? ""
    var body: some View { Form { Section("Pi relay") { TextField("WebSocket URL", text: $relayURL).piURLInput(); SecureField("Relay token", text: $token); Button("Save connection") { model.configure(url: relayURL, token: token) } }; Section { Text("The token stays in iOS Keychain. Use the same RELAY_TOKEN on the Mac relay.").font(.footnote).foregroundStyle(.secondary) } }.navigationTitle("Connection") }
}

private extension View {
    @ViewBuilder func piConversationNavigationTitle(_ title: String) -> some View {
#if os(iOS)
        self.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
#else
        self.navigationTitle(title)
#endif
    }

    func piURLInput() -> some View {
#if os(iOS)
        self.keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
#else
        self
#endif
    }
}

private extension Set where Element == String {
    mutating func toggleMembership(of element: String) { if contains(element) { remove(element) } else { insert(element) } }
}
