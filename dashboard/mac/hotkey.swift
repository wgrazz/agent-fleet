// fleet-hotkey: press ⌃⌥Space anywhere on the Mac to open Jarvis ready to talk. Uses the Carbon hot-key API, which
// needs no Accessibility permission. Run at login by `fleet mac hotkey install`; argument: the URL to open.
import AppKit
import Carbon

let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://127.0.0.1:7878/#/jarvis/talk"

func openJarvis() {
    // the Dock app (Safari "Add to Dock") if there is one, else the default browser
    let app = ["\(NSHomeDirectory())/Applications/Fleet.app", "/Applications/Fleet.app"].first { FileManager.default.fileExists(atPath: $0) }
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = app.map { ["-a", $0, target] } ?? [target]
    try? open.run()
}

var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in openJarvis(); return noErr }, 1, &spec, nil, nil)
var ref: EventHotKeyRef?
let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), EventHotKeyID(signature: OSType(0x464C5452), id: 1),
                                 GetApplicationEventTarget(), 0, &ref)
if status != noErr {
    FileHandle.standardError.write("⌃⌥Space is taken by another app (\(status)).\n".data(using: .utf8)!)
    exit(1)
}
NSApplication.shared.setActivationPolicy(.prohibited) // no Dock icon, no menu bar
NSApplication.shared.run()
