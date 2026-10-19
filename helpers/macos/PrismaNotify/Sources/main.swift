import AppKit
import Foundation
import UserNotifications

// Ayudante de avisos nativos de Prisma Agent (macOS). Ver docs/PLAN-AGENT-NOTIFICATIONS.md.
//
//   PrismaNotify --check
//       imprime {"ok":true} y sale (prueba de arranque).
//   PrismaNotify --post '<json>'
//       {"title","body","image","origin","actions":[{"id","label","kind":"open","url"}],"wait":seconds}
//       Pide permiso la primera vez, postea el aviso y, por stdout, informa UNA línea JSON:
//       {"status":"posted"} | {"status":"denied"} | {"status":"error","message":"…"}.
//       Se queda esperando hasta `wait` segundos por si el usuario toca un botón.
//   (sin argumentos)
//       macOS nos relanzó porque el usuario tocó un botón de un aviso cuando ya habíamos salido:
//       se resuelve igual (la URL viaja en userInfo) y se sale a los pocos segundos.

let categoryPrefix = "prisma.alert."

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

/// Sólo se abren URLs https/http del origen que mandó el agente (el del server al que está conectado).
func open(url string: String, origin: String) {
    guard let url = URL(string: string), let allowed = URL(string: origin),
          url.scheme == allowed.scheme, url.host == allowed.host, url.port == allowed.port else { return }
    NSWorkspace.shared.open(url)
}

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
    var onHandled: (() -> Void)?

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let origin = info["origin"] as? String ?? ""
        let urls = info["urls"] as? [String: String] ?? [:]
        let id = response.actionIdentifier
        if id == UNNotificationDefaultActionIdentifier {
            // Tocar el aviso (no un botón) = la primera acción.
            if let first = info["first"] as? String, let url = urls[first] { open(url: url, origin: origin) }
        } else if let url = urls[id] {
            open(url: url, origin: origin)
        }
        completionHandler()
        onHandled?()
    }
}

let delegate = Delegate()
let center = UNUserNotificationCenter.current()
center.delegate = delegate
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let args = CommandLine.arguments

if args.contains("--check") {
    emit(["ok": true])
    exit(0)
}

guard let postIndex = args.firstIndex(of: "--post"), args.count > postIndex + 1 else {
    // Relanzado por macOS para resolver una respuesta pendiente.
    delegate.onHandled = { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) } }
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { exit(0) }
    app.run()
    exit(0)
}

guard let data = args[postIndex + 1].data(using: .utf8),
      let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    emit(["status": "error", "message": "JSON inválido"])
    exit(1)
}

let title = spec["title"] as? String ?? "Prisma"
let body = spec["body"] as? String ?? ""
let origin = spec["origin"] as? String ?? ""
let wait = spec["wait"] as? Double ?? 300
let actions = (spec["actions"] as? [[String: Any]] ?? []).prefix(3)

delegate.onHandled = { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) } }

center.requestAuthorization(options: [.alert, .sound]) { granted, error in
    if let error = error {
        emit(["status": "error", "message": error.localizedDescription])
        exit(1)
    }
    guard granted else {
        emit(["status": "denied"])
        exit(0)
    }

    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default

    var urls: [String: String] = [:]
    var unActions: [UNNotificationAction] = []
    for action in actions {
        guard let id = action["id"] as? String, let label = action["label"] as? String else { continue }
        if (action["kind"] as? String) == "open", let url = action["url"] as? String { urls[id] = url }
        unActions.append(UNNotificationAction(identifier: id, title: label, options: [.foreground]))
    }
    content.userInfo = ["origin": origin, "urls": urls, "first": unActions.first?.identifier ?? ""]

    let categoryId = categoryPrefix + UUID().uuidString
    center.setNotificationCategories([UNNotificationCategory(identifier: categoryId, actions: unActions, intentIdentifiers: [], options: [])])
    content.categoryIdentifier = categoryId

    if let path = spec["image"] as? String, FileManager.default.fileExists(atPath: path) {
        // macOS mueve el adjunto: se le da una copia.
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".jpg")
        if (try? FileManager.default.copyItem(atPath: path, toPath: copy.path)) != nil,
           let attachment = try? UNNotificationAttachment(identifier: "photo", url: copy) {
            content.attachments = [attachment]
        }
    }

    center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
        if let error = error {
            emit(["status": "error", "message": error.localizedDescription])
            exit(1)
        }
        emit(["status": "posted"])
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { exit(0) }
    }
}

app.run()
