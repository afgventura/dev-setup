// Agent Notifier — a minimal background app that posts native macOS
// notifications for AI-agent events and runs a shell command when one is
// clicked (used to jump to the right tmux tab in Ghostty).
//
// Requests arrive as JSON files dropped into
//   ~/.local/state/agent-notifier/queue/<name>.json
//   {"id","title","subtitle","body","exec"}
// The app drains the queue, posts each notification, and exits after 30 min
// without activity. Started on demand by agent-notify.sh.
import AppKit
import UserNotifications

let queue = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".local/state/agent-notifier/queue")
let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".local/state/agent-notifier/agent-notifier.log")
func log(_ msg: String) {
    let line = "\(Date()) \(msg)\n"
    if let h = try? FileHandle(forWritingTo: logURL) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile() }
    else { try? line.write(to: logURL, atomically: true, encoding: .utf8) }
}

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var lastActivity = Date()

    func applicationDidFinishLaunching(_ note: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        log("launched from \(Bundle.main.bundlePath) id=\(Bundle.main.bundleIdentifier ?? "nil")")
        center.requestAuthorization(options: [.alert, .sound]) { ok, err in
            log("authorization granted=\(ok) error=\(err.map { "\($0)" } ?? "none")")
            center.getNotificationSettings { st in log("authorizationStatus=\(st.authorizationStatus.rawValue) alert=\(st.alertSetting.rawValue)") }
        }
        try? FileManager.default.createDirectory(at: queue, withIntermediateDirectories: true)
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in self.drain() }
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            if Date().timeIntervalSince(self.lastActivity) > 1800 { NSApp.terminate(nil) }
        }
    }

    func drain() {
        guard let files = try? FileManager.default.contentsOfDirectory(at: queue, includingPropertiesForKeys: nil) else { return }
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where file.pathExtension == "json" {
            defer { try? FileManager.default.removeItem(at: file) }
            guard let data = try? Data(contentsOf: file),
                  let req = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { continue }
            let content = UNMutableNotificationContent()
            content.title = req["title"] ?? "Agent"
            content.subtitle = req["subtitle"] ?? ""
            content.body = req["body"] ?? ""
            content.sound = .default
            content.userInfo = ["exec": req["exec"] ?? ""]
            // same id per tab → a newer notification replaces the older one
            let id = req["id"] ?? UUID().uuidString
            content.threadIdentifier = id
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { err in
                log("posted id=\(id) title=\(content.title) error=\(err.map { "\($0)" } ?? "none")")
            }
            lastActivity = Date()
        }
    }

    // banner clicked
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        log("clicked id=\(response.notification.request.identifier)")
        if let cmd = response.notification.request.content.userInfo["exec"] as? String, !cmd.isEmpty {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = ["-c", cmd]
            try? p.run()
        }
        lastActivity = Date()
        done()
    }

    // show banners even while this (background) app is "frontmost"
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // no Dock icon, no menu bar
app.run()
