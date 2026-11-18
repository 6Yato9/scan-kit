// app/settings/help.tsx
// Short, scannable help: how to do the main things in Scan Kit.
// Rows are the shared SettingsRow (tinted icon tile, label, description), the
// same as About, so every list in Settings draws its icons one way.
import { Ionicons } from '@expo/vector-icons';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { ToolScreen } from '@/components/tool-ui';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
type Tip = { icon: IconName; title: string; text: string };

const SECTIONS: { title: string; tips: Tip[] }[] = [
  {
    title: 'Getting started',
    tips: [
      { icon: 'camera-outline', title: 'Scan a document', text: 'Tap the camera button in the middle of the tab bar. Edges are detected for you, and you can scan several pages in a row.' },
      { icon: 'images-outline', title: 'Import photos or PDFs', text: 'On Home, tap Import photos or Import file. The add button in Files offers the same, plus New folder.' },
    ],
  },
  {
    title: 'Working with documents',
    tips: [
      { icon: 'ellipsis-horizontal-circle-outline', title: 'More actions', text: 'Long-press any document to share, rename, duplicate, move, merge or delete it.' },
      { icon: 'checkmark-circle-outline', title: 'Select several', text: 'In Files, tap Select to share, move, merge or delete many documents at once.' },
      { icon: 'crop-outline', title: 'Edit pages', text: 'Open a document and use the toolbar under the page to crop, apply a filter, rotate, mark up or copy its text.' },
      { icon: 'create-outline', title: 'Sign and stamp', text: 'In a document, tap the more button to sign it or add a watermark or timestamp. These save a copy; the original stays as it is.' },
      { icon: 'share-outline', title: 'Share and export', text: 'Send a document as a searchable PDF, a smaller PDF or images, save it to Photos, or print it.' },
    ],
  },
  {
    title: 'Staying organized',
    tips: [
      { icon: 'folder-outline', title: 'Folders', text: 'Create folders in Files. Long-press a folder to rename or delete it; its documents are kept.' },
      { icon: 'search-outline', title: 'Search', text: 'Search finds documents by name and by the text recognized in their pages.' },
    ],
  },
  {
    title: 'Privacy',
    tips: [
      { icon: 'phone-portrait-outline', title: 'On your device', text: 'Your scans are stored only on this device. There is no account and no cloud upload.' },
      { icon: 'lock-closed-outline', title: 'App lock', text: 'Turn on App lock in Settings to require Face ID or your passcode whenever you return to Scan Kit.' },
    ],
  },
];

/** Joins the last two words so a paragraph never ends on a lone short word. */
function noWidow(text: string): string {
  const i = text.lastIndexOf(' ');
  return i > 0 ? `${text.slice(0, i)}\u00A0${text.slice(i + 1)}` : text;
}

export default function HelpScreen() {
  return (
    <ToolScreen title="Help">
      {SECTIONS.map(section => (
        <SettingsGroup key={section.title} title={section.title}>
          {section.tips.map((tip, i) => (
            <SettingsRow
              key={tip.title}
              icon={tip.icon}
              label={tip.title}
              description={noWidow(tip.text)}
              last={i === section.tips.length - 1}
            />
          ))}
        </SettingsGroup>
      ))}
    </ToolScreen>
  );
}
