import AVFoundation
import NaturalLanguage
import UIKit

/// Read aloud with AVSpeechSynthesizer (system voices, on device). One
/// utterance at a time; every event carries its id so a late event from an
/// earlier utterance can be ignored.
///
/// Events (sent through the module):
///   onSpeechProgress { id, start, length }  the word being spoken (UTF-16 range)
///   onSpeechState    { id, state }          speaking | paused | finished | stopped
final class SpeechController: NSObject, AVSpeechSynthesizerDelegate {
  private let synth = AVSpeechSynthesizer()
  private let emit: (String, [String: Any]) -> Void
  private var current: AVSpeechUtterance?
  private var currentId = 0
  private var nextId = 0
  private var sessionActive = false
  private var savedCategory: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
  private var observers: [NSObjectProtocol] = []

  init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
    super.init()
    synth.delegate = self
    // Leaving the app ends reading (no background audio mode; and a document
    // shouldn't keep being read out behind the App Lock).
    observers.append(NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.stop() })
  }

  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    synth.stopSpeaking(at: .immediate)
  }

  /// Starts reading `text`; resolves { id, language }.
  func speak(_ text: String, language: String?, rate: Double?) -> [String: Any] {
    if synth.isSpeaking || synth.isPaused { synth.stopSpeaking(at: .immediate) }
    nextId += 1
    let id = nextId
    let lang = (language?.isEmpty == false ? language : nil) ?? TextActions.dominantLanguage(text)
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = Self.voice(for: lang)
    if let rate = rate, rate.isFinite {
      utterance.rate = Float(min(max(rate, 0.1), 1)) * AVSpeechUtteranceMaximumSpeechRate
    } else {
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate
    }
    current = utterance
    currentId = id
    activateSession()
    synth.speak(utterance)
    return ["id": id, "language": utterance.voice?.language ?? lang ?? ""]
  }

  func pause() { if synth.isSpeaking { synth.pauseSpeaking(at: .word) } }
  func resume() { if synth.isPaused { synth.continueSpeaking() } }
  func stop() {
    if synth.isSpeaking || synth.isPaused {
      synth.stopSpeaking(at: .immediate)
    } else {
      deactivateSession()
    }
  }

  func status() -> [String: Any] {
    let state = synth.isPaused ? "paused" : synth.isSpeaking ? "speaking" : "idle"
    return ["id": currentId, "state": state]
  }

  /// The best installed voice for a language code ("fr", "en-US"): the user's
  /// region first, then the highest quality.
  static func voice(for language: String?) -> AVSpeechSynthesisVoice? {
    guard let language = language, !language.isEmpty else { return nil }
    let voices = AVSpeechSynthesisVoice.speechVoices()
    let wanted = language.lowercased()
    let base = wanted.split(separator: "-").first.map(String.init) ?? wanted
    let candidates = voices.filter {
      let l = $0.language.lowercased()
      return l == wanted || l.hasPrefix(base + "-") || l == base
    }
    guard !candidates.isEmpty else { return AVSpeechSynthesisVoice(language: language) }
    let region = Locale.current.regionCode?.lowercased() ?? ""
    // Where the user's own region has no voice, the language's home region
    // ("fr" → fr-FR rather than fr-CA).
    let home: [String: String] = [
      "fr": "fr-fr", "es": "es-es", "de": "de-de", "it": "it-it", "pt": "pt-pt", "nl": "nl-nl",
      "en": "en-us", "ar": "ar-sa", "zh": "zh-cn", "ja": "ja-jp", "ko": "ko-kr", "ru": "ru-ru",
      "sv": "sv-se", "da": "da-dk", "nb": "nb-no", "fi": "fi-fi", "pl": "pl-pl", "tr": "tr-tr",
    ]
    let homeVoice = home[base]
    func score(_ v: AVSpeechSynthesisVoice) -> Int {
      var s = 0
      let l = v.language.lowercased()
      if l == wanted { s += 100 }
      if !region.isEmpty && l == "\(base)-\(region)" { s += 50 }
      if l == AVSpeechSynthesisVoice.currentLanguageCode().lowercased() { s += 25 }
      if l == homeVoice { s += 40 }
      s += v.quality.rawValue * 10
      if #available(iOS 17.0, *) {
        // Novelty voices (Bells, Bubbles…) are no way to read a document.
        if v.voiceTraits.contains(.isNoveltyVoice) { s -= 1000 }
      }
      return s
    }
    return candidates.max { score($0) < score($1) }
  }

  // MARK: Audio session

  private func activateSession() {
    let session = AVAudioSession.sharedInstance()
    if !sessionActive {
      savedCategory = (session.category, session.mode, session.categoryOptions)
    }
    // Playback so the ring/silent switch doesn't mute an explicit "Read
    // aloud"; other audio ducks while the page is read.
    try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
    try? session.setActive(true)
    sessionActive = true
  }

  private func deactivateSession() {
    guard sessionActive else { return }
    sessionActive = false
    let session = AVAudioSession.sharedInstance()
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
    if let (category, mode, options) = savedCategory {
      try? session.setCategory(category, mode: mode, options: options)
    }
    savedCategory = nil
  }

  // MARK: AVSpeechSynthesizerDelegate

  private func send(_ utterance: AVSpeechUtterance, _ state: String) {
    guard utterance === current else { return }
    emit("onSpeechState", ["id": currentId, "state": state])
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    send(utterance, "speaking")
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didPause utterance: AVSpeechUtterance) {
    send(utterance, "paused")
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
    send(utterance, "speaking")
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    send(utterance, "finished")
    if utterance === current {
      current = nil
      deactivateSession()
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    send(utterance, "stopped")
    if utterance === current {
      current = nil
      deactivateSession()
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
    guard utterance === current else { return }
    emit("onSpeechProgress", ["id": currentId, "start": characterRange.location, "length": characterRange.length])
  }
}
