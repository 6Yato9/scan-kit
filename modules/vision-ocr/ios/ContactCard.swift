import Contacts
import ContactsUI
import UIKit

/// A contact built from fields read off a business card: shown in the system
/// "New Contact" form (the user reviews and saves it), or written as a .vcf.
enum ContactCard {
  static func contact(from f: [String: Any]) -> CNMutableContact {
    let c = CNMutableContact()
    func str(_ k: String) -> String { (f[k] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
    func list(_ k: String) -> [String] {
      ((f[k] as? [Any]) ?? []).compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
    c.namePrefix = str("namePrefix")
    c.givenName = str("givenName")
    c.middleName = str("middleName")
    c.familyName = str("familyName")
    c.nameSuffix = str("nameSuffix")
    c.organizationName = str("organizationName")
    c.departmentName = str("departmentName")
    c.jobTitle = str("jobTitle")
    c.note = str("note")

    let phones = (f["phones"] as? [[String: Any]]) ?? []
    c.phoneNumbers = phones.compactMap { p in
      guard let number = (p["number"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !number.isEmpty else { return nil }
      let label: String
      switch p["label"] as? String {
      case "mobile": label = CNLabelPhoneNumberMobile
      case "fax": label = CNLabelPhoneNumberWorkFax
      case "main": label = CNLabelPhoneNumberMain
      default: label = CNLabelWork
      }
      return CNLabeledValue(label: label, value: CNPhoneNumber(stringValue: number))
    }
    c.emailAddresses = list("emails").map { CNLabeledValue(label: CNLabelWork, value: $0 as NSString) }
    c.urlAddresses = list("urls").map { CNLabeledValue(label: CNLabelURLAddressHomePage, value: $0 as NSString) }
    let addresses = (f["addresses"] as? [[String: Any]]) ?? []
    c.postalAddresses = addresses.compactMap { a in
      let p = CNMutablePostalAddress()
      p.street = (a["street"] as? String) ?? ""
      p.city = (a["city"] as? String) ?? ""
      p.state = (a["state"] as? String) ?? ""
      p.postalCode = (a["postalCode"] as? String) ?? ""
      p.country = (a["country"] as? String) ?? ""
      if p.street.isEmpty && p.city.isEmpty && p.postalCode.isEmpty && p.country.isEmpty { return nil }
      return CNLabeledValue(label: CNLabelWork, value: p.copy() as! CNPostalAddress)
    }
    if let uri = f["imageUri"] as? String, !uri.isEmpty,
       let cg = TextActions.uprightImage(path: TextActions.filePath(uri), maxPixel: 720) {
      c.imageData = UIImage(cgImage: cg).jpegData(compressionQuality: 0.8)
    }
    return c
  }

  /// Writes a vCard (3.0) of the contact to `outPath`.
  static func writeVCard(_ f: [String: Any], outPath: String) throws {
    let c = contact(from: f)
    var data = try CNContactVCardSerialization.data(with: [c])
    // The serializer leaves the photo out; add it so the card keeps its picture.
    if let image = c.imageData, var text = String(data: data, encoding: .utf8),
       let end = text.range(of: "END:VCARD", options: .backwards) {
      let b64 = image.base64EncodedString()
      // Lines are folded at 75 octets (RFC 2425 §5.8.1): continuation lines start with a space.
      var folded = "PHOTO;ENCODING=b;TYPE=JPEG:"
      var line = folded.count
      folded.reserveCapacity(b64.count + b64.count / 70 * 3 + 32)
      for ch in b64 {
        if line >= 75 { folded += "\r\n "; line = 1 }
        folded.append(ch)
        line += 1
      }
      text.insert(contentsOf: folded + "\r\n", at: end.lowerBound)
      data = Data(text.utf8)
    }
    let url = URL(fileURLWithPath: outPath)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
  }
}

/// Presents CNContactViewController(forNewContact:) in its own navigation
/// controller. Resolves "saved" or "cancelled" (also when the form goes away
/// without an answer, e.g. under App Lock).
final class NewContactPresenter: NSObject, CNContactViewControllerDelegate {
  private var finish: ((String) -> Void)?
  private var keepAlive: NewContactPresenter?

  static func present(from root: UIViewController?, fields: [String: Any], completion: @escaping (String) -> Void) {
    guard let top = Presenter.top(from: root) else { completion("unavailable"); return }
    let presenter = NewContactPresenter()
    presenter.keepAlive = presenter
    presenter.finish = completion
    let vc = CNContactViewController(forNewContact: ContactCard.contact(from: fields))
    vc.contactStore = CNContactStore()
    vc.delegate = presenter
    vc.allowsActions = false
    let nav = UINavigationController(rootViewController: vc)
    nav.modalPresentationStyle = .formSheet
    // A half-filled form isn't swiped away by accident.
    nav.isModalInPresentation = true
    top.present(nav, animated: true)
    Presenter.watch(nav) { [weak presenter] in presenter?.settle("cancelled") }
  }

  private func settle(_ outcome: String) {
    guard let finish = finish else { return }
    self.finish = nil
    keepAlive = nil
    finish(outcome)
  }

  func contactViewController(_ viewController: CNContactViewController, didCompleteWith contact: CNContact?) {
    (viewController.navigationController ?? viewController).dismiss(animated: true)
    settle(contact == nil ? "cancelled" : "saved")
  }
}
