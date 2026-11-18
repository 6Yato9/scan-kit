import EventKit
import EventKitUI
import UIKit

/// The system "New Event" editor, prefilled. Nothing is written unless the
/// user taps Add.
///
/// iOS 17+: the editor runs out of process and needs no calendar permission
/// (none is requested). iOS 15.5–16: it needs calendar access, asked for here
/// the first time (NSCalendarsUsageDescription); a refusal resolves "denied".
final class EventEditorPresenter: NSObject, EKEventEditViewDelegate {
  private var finish: ((String) -> Void)?
  private var keepAlive: EventEditorPresenter?

  static func present(
    from root: UIViewController?,
    title: String,
    start: Date,
    end: Date,
    allDay: Bool,
    notes: String?,
    location: String?,
    completion: @escaping (String) -> Void
  ) {
    let store = EKEventStore()
    let show = {
      guard let top = Presenter.top(from: root) else { completion("unavailable"); return }
      let event = EKEvent(eventStore: store)
      event.title = title
      event.startDate = start
      event.endDate = end
      event.isAllDay = allDay
      if let notes = notes, !notes.isEmpty { event.notes = notes }
      if let location = location, !location.isEmpty { event.location = location }
      let presenter = EventEditorPresenter()
      presenter.keepAlive = presenter
      presenter.finish = completion
      let vc = EKEventEditViewController()
      vc.eventStore = store
      vc.event = event
      vc.editViewDelegate = presenter
      top.present(vc, animated: true)
      Presenter.watch(vc) { [weak presenter] in presenter?.settle("cancelled") }
    }
    if #available(iOS 17.0, *) {
      show()
      return
    }
    switch EKEventStore.authorizationStatus(for: .event) {
    case .authorized:
      show()
    case .notDetermined:
      store.requestAccess(to: .event) { granted, _ in
        DispatchQueue.main.async { granted ? show() : completion("denied") }
      }
    default:
      completion("denied")
    }
  }

  private func settle(_ outcome: String) {
    guard let finish = finish else { return }
    self.finish = nil
    keepAlive = nil
    finish(outcome)
  }

  func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
    controller.dismiss(animated: true)
    settle(action == .saved ? "saved" : "cancelled")
  }
}
