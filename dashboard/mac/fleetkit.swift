// fleetkit: Calendar and Reminders for Jarvis, through EventKit (handles recurring events, every account the Mac
// has: iCloud, Google, Exchange). JSON on stdout. Built by `fleet mac setup` into ~/.fleet/bin/fleetkit.
//   fleetkit events FROM TO                          ISO dates/times
//   fleetkit add-event TITLE START MINUTES [CALENDAR] [NOTES]
//   fleetkit reminders [LIST]                        incomplete ones
//   fleetkit add-reminder TITLE [DUE] [LIST] [NOTES]  DUE may be ""
import EventKit
import Foundation

let store = EKEventStore()
let args = Array(CommandLine.arguments.dropFirst())

func out(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    out(["error": message])
    exit(code)
}

func access(_ type: EKEntityType) {
    let done = DispatchSemaphore(value: 0)
    var granted = false
    let finish: (Bool, Error?) -> Void = { ok, _ in granted = ok; done.signal() }
    if type == .event { store.requestFullAccessToEvents(completion: finish) } else { store.requestFullAccessToReminders(completion: finish) }
    done.wait()
    if !granted {
        fail("No access to \(type == .event ? "Calendar" : "Reminders"). Allow it in System Settings → Privacy & Security → \(type == .event ? "Calendars" : "Reminders").", 2)
    }
}

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
func date(_ s: String) -> Date? {
    if let d = iso.date(from: s) { return d }
    for format in ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = format
        if let d = f.date(from: s) { return d }
    }
    return nil
}
func stamp(_ d: Date?) -> Any { d.map { iso.string(from: $0) } ?? NSNull() }

switch args.first {
case "events":
    access(.event)
    guard args.count >= 3, let from = date(args[1]), let to = date(args[2]) else { fail("usage: events FROM TO") }
    let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
        .sorted { $0.startDate < $1.startDate }
    out(events.map { ["title": $0.title ?? "", "start": stamp($0.startDate), "end": stamp($0.endDate), "all_day": $0.isAllDay,
                      "calendar": $0.calendar.title, "location": $0.location ?? ""] as [String: Any] })
case "add-event":
    access(.event)
    guard args.count >= 4, let start = date(args[2]), let minutes = Double(args[3]) else { fail("usage: add-event TITLE START MINUTES [CALENDAR] [NOTES]") }
    let e = EKEvent(eventStore: store)
    e.title = args[1]
    e.startDate = start
    e.endDate = start.addingTimeInterval(minutes * 60)
    let wanted = args.count > 4 ? args[4] : ""
    e.calendar = store.calendars(for: .event).first { $0.title == wanted && $0.allowsContentModifications } ?? store.defaultCalendarForNewEvents
    if args.count > 5 { e.notes = args[5] }
    do { try store.save(e, span: .thisEvent); out(["ok": true, "calendar": e.calendar.title, "start": stamp(e.startDate)]) } catch { fail("\(error.localizedDescription)") }
case "reminders":
    access(.reminder)
    let lists = args.count > 1 ? store.calendars(for: .reminder).filter { $0.title == args[1] } : nil
    let done = DispatchSemaphore(value: 0)
    var found: [EKReminder] = []
    store.fetchReminders(matching: store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)) { found = $0 ?? []; done.signal() }
    done.wait()
    out(found.prefix(200).map { ["title": $0.title ?? "", "due": stamp($0.dueDateComponents?.date ?? Calendar.current.date(from: $0.dueDateComponents ?? DateComponents())), "list": $0.calendar.title] as [String: Any] })
case "add-reminder":
    access(.reminder)
    guard args.count >= 2 else { fail("usage: add-reminder TITLE [DUE] [LIST] [NOTES]") }
    let r = EKReminder(eventStore: store)
    r.title = args[1]
    if args.count > 2, !args[2].isEmpty, let due = date(args[2]) {
        r.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
        r.addAlarm(EKAlarm(absoluteDate: due))
    }
    let wanted = args.count > 3 ? args[3] : ""
    r.calendar = store.calendars(for: .reminder).first { $0.title == wanted } ?? store.defaultCalendarForNewReminders()
    if args.count > 4 { r.notes = args[4] }
    do { try store.save(r, commit: true); out(["ok": true, "list": r.calendar.title]) } catch { fail("\(error.localizedDescription)") }
default:
    fail("commands: events, add-event, reminders, add-reminder")
}
