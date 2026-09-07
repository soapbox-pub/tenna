import { InstalledAppPicker } from '@/components/InstalledAppPicker';
import { NsitePicker } from '@/components/NsitePicker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supportsNativeApps } from '@/lib/nativeAppsPlugin';

interface AddAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Everything already on the wall, so the same thing isn't added twice. */
  addedUris: string[];
  /** One verb for both lists — a tile is a tile. See `wallUri`. */
  onAdd: (uri: string) => void;
}

const TAB_LIST = 'w-full bg-white/5 p-1';
const TAB =
  'text-white/60 data-[state=active]:bg-white/12 data-[state=active]:text-white focus-visible:ring-[#FEF960]/60';

/**
 * The two places something on the wall can come from.
 *
 * A site comes off a relay and an app is already on the device, but the wall
 * makes no distinction between what they produce — both are tiles, and this is
 * the only screen where the difference is visible at all. So they are two
 * lists of the same shape, side by side, and picking from either is one press.
 *
 * On anything but Android there is no second list to offer, so the dialog is
 * just the one, with no tabs above it to explain themselves.
 */
export function AddAppDialog({ open, onOpenChange, addedUris, onAdd }: AddAppDialogProps) {
  const native = supportsNativeApps();

  const pick = (uri: string) => {
    onAdd(uri);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/10 bg-[#1B080C] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add an app</DialogTitle>
          <DialogDescription className="text-white/70">
            {native
              ? 'Put a Nostr site or one of this device\u2019s own apps on your wall.'
              : 'Put a Nostr site on your wall.'}
          </DialogDescription>
        </DialogHeader>

        {native ? (
          <Tabs defaultValue="nostr">
            <TabsList className={TAB_LIST}>
              <TabsTrigger value="nostr" className={TAB}>
                Nostr site
              </TabsTrigger>
              <TabsTrigger value="installed" className={TAB}>
                On this device
              </TabsTrigger>
            </TabsList>

            <TabsContent value="nostr" className="pt-4">
              <NsitePicker addedUris={addedUris} onAdd={pick} />
            </TabsContent>

            <TabsContent value="installed" className="pt-4">
              <InstalledAppPicker addedUris={addedUris} onAdd={pick} />
            </TabsContent>
          </Tabs>
        ) : (
          <NsitePicker addedUris={addedUris} onAdd={pick} />
        )}
      </DialogContent>
    </Dialog>
  );
}
