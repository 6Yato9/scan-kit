package expo.modules.visionocr

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Read aloud with the system's text-to-speech engine (Speech.swift on iOS),
 * on the device: only voices that need no network are used. One reading at a
 * time; every event carries the id speak() returned, so a late event from an
 * earlier reading can be ignored.
 *
 * Events (sent through the module), the same as iOS:
 *   onSpeechProgress { id, start, length }  the word being spoken (UTF-16 range)
 *   onSpeechState    { id, state }          speaking | paused | finished | stopped
 *
 * Android's TextToSpeech can't pause. Pause stops the engine and remembers
 * the word it had reached (from onRangeStart); resume speaks again from that
 * word, under the same id, with the ranges shifted back onto the whole text.
 * The text is queued as sentences (SpeechText.chunks), so an engine that
 * reports no word ranges still resumes at the sentence it was reading, and
 * nothing exceeds the engine's input limit.
 */
class SpeechController(
  context: Context,
  private val emit: (String, Map<String, Any>) -> Unit,
  private val detectLanguage: (String) -> String?,
) {
  private val app = context.applicationContext
  private val lock = Object()
  private var tts: TextToSpeech? = null
  private var ready: CountDownLatch? = null
  private var initOk = false

  // The reading (all guarded by `lock`).
  private var nextId = 0
  private var currentId = 0
  /** Bumped whenever the engine is stopped or restarted: callbacks of older utterances are dropped. */
  private var generation = 0
  private var text = ""
  private var chunks: List<SpeechText.Chunk> = emptyList()
  private var state = "idle"
  /** Where reading (re)starts: the last word reached, or the start of the sentence being read. */
  private var resumeAt = 0
  private var focus: AudioFocusRequest? = null
  /** Utterance id of the first piece queued by the latest (re)start: it reports "speaking". */
  private var firstUtterance: String? = null

  private val audio get() = app.getSystemService(AudioManager::class.java)

  /** The engine, created (and waited for, up to 8 s) on first use. Throws when the device has none. */
  private fun engine(): TextToSpeech {
    val latch: CountDownLatch
    synchronized(lock) {
      tts?.let { if (ready?.count == 0L) { if (initOk) return it else throw VisionFailure("ERR_SPEECH", "Text to speech isn’t available") } }
      if (tts == null) {
        val l = CountDownLatch(1)
        ready = l
        tts = TextToSpeech(app) { status ->
          initOk = status == TextToSpeech.SUCCESS
          l.countDown()
        }.also { it.setOnUtteranceProgressListener(listener) }
      }
      latch = ready!!
    }
    if (!latch.await(8, TimeUnit.SECONDS) || !initOk) {
      throw VisionFailure("ERR_SPEECH", "Text to speech isn’t available")
    }
    return tts!!
  }

  /** Starts reading `text`; resolves { id, language }. */
  fun speak(text: String, language: String?, rate: Double?): Map<String, Any> {
    val engine = engine()
    val lang = language?.takeIf { it.isNotBlank() } ?: detectLanguage(text)
    val voice = chooseVoice(engine, lang)
    if (voice != null) {
      engine.voice = voice
    } else if (lang != null) {
      engine.language = Locale.forLanguageTag(lang)
    }
    // iOS: 0.1…1 of the maximum rate, the default being half of it; Android's 1.0 is normal speed.
    engine.setSpeechRate(if (rate != null && rate.isFinite()) (rate.coerceIn(0.1, 1.0) * 2).toFloat() else 1f)
    engine.setAudioAttributes(attributes)
    val id: Int
    synchronized(lock) {
      nextId += 1
      id = nextId
      currentId = id
      this.text = text
      chunks = SpeechText.chunks(text, SpeechText.MAX_CHUNK.coerceAtMost(TextToSpeech.getMaxSpeechInputLength() - 1))
      resumeAt = 0
      startLocked(engine, 0)
    }
    val spoken = voice?.locale?.toLanguageTag() ?: lang ?: engine.voice?.locale?.toLanguageTag() ?: ""
    return mapOf("id" to id, "language" to spoken)
  }

  fun pause() {
    synchronized(lock) {
      if (state != "speaking") return
      generation += 1
      tts?.stop()
      state = "paused"
      send("paused")
    }
  }

  fun resume() {
    synchronized(lock) {
      if (state != "paused") return
      val engine = tts ?: return
      startLocked(engine, resumeAt)
    }
  }

  fun stop() {
    synchronized(lock) {
      if (state == "idle") return
      generation += 1
      tts?.stop()
      state = "idle"
      send("stopped")
      releaseFocus()
    }
  }

  fun shutdown() {
    synchronized(lock) {
      generation += 1
      state = "idle"
      releaseFocus()
      try { tts?.shutdown() } catch (_: Exception) {}
      tts = null
      ready = null
    }
  }

  /** Queues the text from character `from` (a word start) to the end. Holds `lock`. */
  private fun startLocked(engine: TextToSpeech, from: Int) {
    generation += 1
    engine.stop()
    requestFocus()
    state = "speaking"
    val gen = generation
    var first = true
    for ((index, chunk) in chunks.withIndex()) {
      if (chunk.start + chunk.length <= from) continue
      val start = maxOf(chunk.start, from)
      val piece = text.substring(start, chunk.start + chunk.length)
      if (piece.isBlank()) continue
      val params = Bundle()
      val utterance = "$gen:$index:$start"
      if (first) firstUtterance = utterance
      val result = engine.speak(piece, if (first) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, params, utterance)
      if (result != TextToSpeech.SUCCESS) Log.w(TAG, "speak: engine refused a sentence ($result)")
      first = false
    }
    if (first) {
      // Nothing left to read (resumed after the last word).
      state = "idle"
      send("finished")
      releaseFocus()
    }
  }

  private fun send(state: String) {
    emit("onSpeechState", mapOf("id" to currentId, "state" to state))
  }

  /** gen:index:start of one of the current generation's utterances, else null. */
  private fun parse(utteranceId: String?): Triple<Int, Int, Int>? {
    val parts = utteranceId?.split(':') ?: return null
    if (parts.size != 3) return null
    val gen = parts[0].toIntOrNull() ?: return null
    val index = parts[1].toIntOrNull() ?: return null
    val start = parts[2].toIntOrNull() ?: return null
    return if (gen == generation) Triple(gen, index, start) else null
  }

  private val listener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {
      synchronized(lock) {
        val (_, _, start) = parse(utteranceId) ?: return
        resumeAt = start
        // Once per (re)start: its first queued sentence.
        if (utteranceId == firstUtterance) send("speaking")
      }
    }

    override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
      synchronized(lock) {
        val (_, _, offset) = parse(utteranceId) ?: return
        if (end <= start) return
        resumeAt = offset + start
        emit("onSpeechProgress", mapOf("id" to currentId, "start" to offset + start, "length" to end - start))
      }
    }

    override fun onDone(utteranceId: String?) {
      synchronized(lock) {
        val (_, index, _) = parse(utteranceId) ?: return
        if (index != chunks.lastIndex) return
        state = "idle"
        send("finished")
        releaseFocus()
      }
    }

    override fun onStop(utteranceId: String?, interrupted: Boolean) {
      // Only ever after our own stop(): pause/stop already reported it.
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String?) {
      onError(utteranceId, TextToSpeech.ERROR)
    }

    override fun onError(utteranceId: String?, errorCode: Int) {
      synchronized(lock) {
        parse(utteranceId) ?: return
        Log.w(TAG, "speech error $errorCode")
        generation += 1
        tts?.stop()
        state = "idle"
        send("stopped")
        releaseFocus()
      }
    }
  }

  // ── Audio focus: other audio ducks while a page is read (iOS: .duckOthers).

  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  private fun requestFocus() {
    if (focus != null) return
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(attributes)
      .setOnAudioFocusChangeListener { change ->
        // A call or another app taking the audio: stop rather than talk over it.
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) pause()
      }
      .build()
    focus = request
    try { audio?.requestAudioFocus(request) } catch (_: Exception) {}
  }

  private fun releaseFocus() {
    val request = focus ?: return
    focus = null
    try { audio?.abandonAudioFocusRequest(request) } catch (_: Exception) {}
  }

  companion object {
    private const val TAG = "VisionOcr"

    /**
     * The best installed voice for a language code ("fr", "en-US") that needs
     * no network: the exact tag first, then the user's region, the language's
     * home region (as iOS), then quality. Null when none is installed.
     */
    fun chooseVoice(engine: TextToSpeech, language: String?): Voice? {
      if (language.isNullOrBlank()) return null
      val voices = try { engine.voices } catch (_: Exception) { null } ?: return null
      val options = voices.map {
        SpeechText.VoiceOption(
          it.name,
          it.locale.toLanguageTag(),
          it.quality,
          it.isNetworkConnectionRequired,
          it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) == true,
        )
      }
      val best = SpeechText.bestVoice(options, language, Locale.getDefault().country) ?: return null
      return voices.firstOrNull { it.name == best.name }
    }
  }
}

/** Pure helpers of SpeechController (JVM-tested). */
object SpeechText {
  /** Longest piece queued at once (well under TextToSpeech.getMaxSpeechInputLength(), 4000). */
  const val MAX_CHUNK = 1000

  data class Chunk(val start: Int, val length: Int)

  /**
   * `text` cut into consecutive pieces that cover it exactly: sentences (a
   * full stop, ! or ? and the spaces after it; a line break), each at most
   * `max` characters (a longer sentence is cut at its last space before the
   * limit, or hard at the limit).
   */
  fun chunks(text: String, max: Int = MAX_CHUNK): List<Chunk> {
    val limit = max.coerceAtLeast(16)
    val out = ArrayList<Chunk>()
    var start = 0
    var i = 0
    while (i < text.length) {
      val c = text[i]
      val ends = c == '\n' || ((c == '.' || c == '!' || c == '?' || c == '。' || c == '؟') &&
        (i + 1 == text.length || text[i + 1].isWhitespace()))
      if (ends) {
        var j = i + 1
        while (j < text.length && text[j].isWhitespace()) j++
        addCapped(text, start, j, limit, out)
        start = j
        i = j
        continue
      }
      i++
    }
    if (start < text.length) addCapped(text, start, text.length, limit, out)
    return out
  }

  private fun addCapped(text: String, from: Int, to: Int, limit: Int, out: MutableList<Chunk>) {
    var s = from
    while (to - s > limit) {
      var cut = text.lastIndexOf(' ', s + limit)
      if (cut <= s) cut = s + limit else cut += 1
      // Never split a surrogate pair.
      if (cut < to && Character.isLowSurrogate(text[cut])) cut -= 1
      out.add(Chunk(s, cut - s))
      s = cut
    }
    if (to > s) out.add(Chunk(s, to - s))
  }

  data class VoiceOption(
    val name: String,
    val tag: String,
    val quality: Int,
    val network: Boolean,
    val notInstalled: Boolean,
  )

  /** Where the user's own region has no voice, the language's home region ("fr" → fr-FR rather than fr-CA). */
  private val home = mapOf(
    "fr" to "fr-fr", "es" to "es-es", "de" to "de-de", "it" to "it-it", "pt" to "pt-pt", "nl" to "nl-nl",
    "en" to "en-us", "ar" to "ar-sa", "zh" to "zh-cn", "ja" to "ja-jp", "ko" to "ko-kr", "ru" to "ru-ru",
    "sv" to "sv-se", "da" to "da-dk", "nb" to "nb-no", "fi" to "fi-fi", "pl" to "pl-pl", "tr" to "tr-tr",
  )

  fun bestVoice(voices: List<VoiceOption>, language: String, region: String): VoiceOption? {
    val wanted = language.lowercase().replace('_', '-')
    val base = wanted.substringBefore('-')
    val reg = region.lowercase()
    val candidates = voices.filter { v ->
      val l = v.tag.lowercase()
      !v.network && !v.notInstalled && (l == wanted || l == base || l.startsWith("$base-"))
    }
    fun score(v: VoiceOption): Int {
      val l = v.tag.lowercase()
      var s = 0
      if (l == wanted) s += 100
      if (reg.isNotEmpty() && l == "$base-$reg") s += 50
      if (l == home[base]) s += 40
      s += v.quality / 10
      return s
    }
    return candidates.maxByOrNull { score(it) }
  }
}
