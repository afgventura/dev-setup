import SwiftUI

@main
struct RemoteAgentApp: App {
    @StateObject private var model = AgentModel()
    var body: some Scene { WindowGroup { ContentView().environmentObject(model) } }
}

struct ContentView: View {
    @EnvironmentObject private var model: AgentModel
    @AppStorage("relayURL") private var relayURL = "ws://127.0.0.1:8765"
    var body: some View {
        NavigationStack {
            List(model.sessions, id: \.id) { item in
                NavigationLink(item.title) { SessionView(sessionId: item.id).environmentObject(model) }
                    .badge(item.state)
            }
            .navigationTitle("Agents")
            .toolbar { ToolbarItem { NavigationLink("Connection") { ConnectionView(relayURL: $relayURL) } } }
            .overlay { if model.sessions.isEmpty { VStack { Image(systemName: "bubble.left.and.bubble.right"); Text("No sessions"); Text("Connect the Mac bridge to see a Pi session.").font(.footnote).foregroundStyle(.secondary) } } }
        }
        .safeAreaInset(edge: .bottom) { Text(model.connectionState).font(.caption).foregroundStyle(.secondary).padding(.vertical, 4) }
        .task { await model.connect() }
    }
}

struct SessionView: View {
    @EnvironmentObject private var model: AgentModel
    let sessionId: String
    @State private var draft = ""
    @State private var sendMode = "steer"
    private var canControl: Bool { model.connectionState == "connected" }
    private var isBusy: Bool { ["running", "retrying", "compacting"].contains(sessionState) }
    private var sessionState: String { model.sessions.first(where: { $0.id == sessionId })?.state ?? "connecting" }
    var body: some View {
        let session = model.sessions.first(where: { $0.id == sessionId }) ?? AgentSession(id: sessionId, title: "Pi session", state: "connecting", messages: [], question: nil)
        VStack(spacing: 0) {
            ScrollView { LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(session.messages) { message in
                    Text(message.text).frame(maxWidth: .infinity, alignment: .leading).padding(10).background(message.role == "assistant" ? Color.blue.opacity(0.12) : Color.gray.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 10))
                }
                if let question = session.question { QuestionView(question: question) { answer in model.answer(session.id, questionId: question.id, answer: answer) } }
            }.padding() }
            if isBusy { Picker("When running", selection: $sendMode) { Text("Steer current run").tag("steer"); Text("Queue follow-up").tag("follow_up") }.pickerStyle(.segmented).padding(.horizontal); Button("Abort", role: .destructive) { model.abort(session.id) }.disabled(!canControl).padding(.top, 4) }
            HStack { TextField("Message Pi…", text: $draft, axis: .vertical).textFieldStyle(.roundedBorder); Button("Send") { let text=draft; draft=""; if isBusy && sendMode == "steer" { model.steer(session.id, text: text) } else if isBusy { model.followUp(session.id, text: text) } else { model.prompt(session.id, text: text) } }.disabled(!canControl || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }.padding()
        }.navigationTitle(session.title)
    }
}

struct ConnectionView: View {
    @EnvironmentObject private var model: AgentModel
    @Binding var relayURL: String
    @State private var token = KeychainStore.read() ?? ""
    var body: some View { Form { TextField("Relay WebSocket URL", text: $relayURL); SecureField("Relay token", text: $token); Button("Save") { model.configure(url: relayURL, token: token) }; Text("The token is stored in iOS Keychain. Export the same value as RELAY_TOKEN on the Mac.").font(.footnote).foregroundStyle(.secondary) }.navigationTitle("Connection") }
}

struct QuestionView: View {
    let question: AgentQuestion; let submit: ([String: Any]) -> Void
    @State private var text: String
    @State private var selected = Set<String>()
    @State private var submitted = false
    init(question: AgentQuestion, submit: @escaping ([String: Any]) -> Void) { self.question = question; self.submit = submit; _text = State(initialValue: question.prefill ?? "") }
    private func send(_ answer: [String: Any]) { guard !submitted else { return }; submitted = true; submit(answer) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { Text(question.title).font(.headline); if let message=question.message { Text(message) }
            if question.kind == "choice", let options=question.options { ForEach(options, id: \.self) { option in Button(option) { send(["value": option]) } }.buttonStyle(.bordered); Button("Cancel") { send(["cancelled": true]) }.foregroundStyle(.secondary) }
            if question.kind == "multi_select", let options=question.options { ForEach(options, id: \.self) { option in Button { if selected.contains(option) { selected.remove(option) } else { selected.insert(option) } } label: { Label(option, systemImage: selected.contains(option) ? "checkmark.square.fill" : "square") } }.buttonStyle(.plain); HStack { Button("Cancel") { send(["cancelled": true]) }; Button("Submit") { send(["values": Array(selected)]) }.buttonStyle(.borderedProminent) } }
            if question.kind == "confirmation" { HStack { Button("Cancel") { send(["cancelled": true]) }; Button("No") { send(["confirmed": false]) }; Button("Yes") { send(["confirmed": true]) }.buttonStyle(.borderedProminent) } }
            if ["input", "editor"].contains(question.kind) { TextField(question.placeholder ?? "Enter a response", text: $text, axis: .vertical); HStack { Button("Cancel") { send(["cancelled": true]) }; Button("Submit") { send(["value": text]) }.buttonStyle(.borderedProminent) } }
        }.padding().background(Color.orange.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
