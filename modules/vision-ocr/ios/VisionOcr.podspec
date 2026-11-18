Pod::Spec.new do |s|
  s.name           = 'VisionOcr'
  s.version        = '1.0.0'
  s.summary        = 'On-device text recognition with Apple Vision'
  s.description    = 'Recognises text and line bounding boxes in an image file using VNRecognizeTextRequest.'
  s.author         = ''
  s.homepage       = 'https://github.com/6Yato9/scan-kit'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.5' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'Vision', 'PDFKit', 'AVFoundation', 'CoreMotion', 'CoreImage', 'ImageIO', 'NaturalLanguage', 'Contacts', 'ContactsUI', 'EventKit', 'EventKitUI'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files   = '**/*.{h,m,mm,swift}'
end
