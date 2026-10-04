import { Plus } from 'lucide-react';
import { useState } from 'react';

import { NsiteInfoPage } from '@/components/NsiteInfoPage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useNsiteEnv } from '@/hooks/useNsiteEnv';
import { useToast } from '@/hooks/useToast';
import { impactLight, notificationError } from '@/lib/haptics';
import {
  MAX_VARIABLES,
  parseEnvName,
  parseEnvValue,
  removeNsiteEnvVariable,
  setNsiteEnvVariable,
} from '@/lib/nsiteEnv';

interface NsiteEnvironmentProps {
  siteId: string;
  /** What the site is called on the wall. */
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The variable being written. `original` is its name as stored, for one that already exists. */
interface Draft {
  original?: string;
  name: string;
  value: string;
}

/**
 * The draft as it would be stored, or the first complaint the rules make —
 * so Save goes live exactly when saving would be accepted.
 */
function parseDraft(draft: Draft): { name: string; value: string } | { error: string } {
  try {
    return { name: parseEnvName(draft.name), value: parseEnvValue(draft.value) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A site's `window.ENV`, one screen deeper than its App info.
 *
 * A variable is a row showing its name and value; pressing one opens it for
 * editing in place, and the button at the foot opens an empty one. See
 * `NsiteInfoPage` for the screen around it.
 */
export function NsiteEnvironment({ siteId, name, open, onOpenChange }: NsiteEnvironmentProps) {
  const variables = useNsiteEnv(siteId);
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);

  const full = variables.length >= MAX_VARIABLES;

  const close = (next: boolean) => {
    if (!next) setDraft(null);
    onOpenChange(next);
  };

  const parsed = draft ? parseDraft(draft) : undefined;
  // A new variable under a name already in use would quietly replace it, so
  // the form points at the one that exists instead.
  const taken = !!draft && !!parsed && !('error' in parsed)
    && parsed.name !== draft.original
    && variables.some(([n]) => n === parsed.name);
  const problem = parsed && 'error' in parsed
    ? parsed.error
    : taken && parsed && !('error' in parsed)
      ? `${parsed.name} is already set. Edit it instead.`
      : undefined;

  const save = () => {
    if (!draft || !parsed || 'error' in parsed || taken) return;
    try {
      setNsiteEnvVariable(siteId, parsed.name, parsed.value);
      // Renaming is saving under the new name and forgetting the old one.
      if (draft.original && draft.original !== parsed.name) {
        removeNsiteEnvVariable(siteId, draft.original);
      }
      impactLight();
      setDraft(null);
    } catch (error) {
      notificationError();
      toast({
        title: "Couldn't save that variable",
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  const remove = (variable: string) => {
    removeNsiteEnvVariable(siteId, variable);
    impactLight();
    setDraft(null);
  };

  const form = draft && (
    <form
      className="flex flex-col gap-3 px-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="nsite-env-name" className="text-sm text-foreground/70">Name</Label>
        <Input
          id="nsite-env-name"
          autoFocus={!draft.original}
          value={draft.name}
          placeholder="API_URL"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 select-text font-mono text-base md:text-base"
          aria-invalid={!!problem && !!draft.name.trim()}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="nsite-env-value" className="text-sm text-foreground/70">Value</Label>
        <Textarea
          id="nsite-env-value"
          autoFocus={!!draft.original}
          value={draft.value}
          placeholder="https://api.example.com"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          rows={1}
          className="min-h-11 select-text break-all font-mono text-base md:text-base"
          onChange={(event) => setDraft({ ...draft, value: event.target.value })}
        />
      </div>

      {/* Only once something has been typed, so an empty form isn't scolding
          anyone for not having filled it in yet. */}
      {problem && (!!draft.name.trim() || !!draft.value) && (
        <p className="text-sm text-destructive">{problem}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        {draft.original && (
          <Button
            type="button"
            variant="ghost"
            className="h-10 px-3 text-base text-destructive hover:bg-foreground/10 hover:text-destructive"
            onClick={() => remove(draft.original!)}
          >
            Remove
          </Button>
        )}
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          className="h-10 px-4 text-base hover:bg-foreground/10"
          onClick={() => setDraft(null)}
        >
          Cancel
        </Button>
        <Button type="submit" className="h-10 px-5 text-base" disabled={!!problem}>
          Save
        </Button>
      </div>
    </form>
  );

  return (
    <NsiteInfoPage title="Environment" open={open} onOpenChange={close}>
      <p className="px-1 pb-2 text-base text-foreground/60">
        {name} reads these as <code className="font-mono text-foreground/80">window.ENV</code>,
        before any of its own scripts run. Changes apply the next time it opens.
      </p>

      <section className="rounded-2xl bg-foreground/[0.06] px-3 py-2">
        {variables.length === 0 && !draft ? (
          <p className="px-2 py-3 text-base text-foreground/55">
            No variables. The site sees no <code className="font-mono">window.ENV</code> at all.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {variables.map(([key, value]) => (
              <li key={key}>
                {draft?.original === key ? form : (
                  <button
                    type="button"
                    onClick={() => setDraft({ original: key, name: key, value })}
                    aria-label={`Edit ${key}`}
                    className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg px-2 py-3 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <span className="w-full truncate font-mono text-base text-foreground/90">{key}</span>
                    <span className="w-full truncate font-mono text-sm text-foreground/55">
                      {value === '' ? <span className="italic">empty</span> : value}
                    </span>
                  </button>
                )}
              </li>
            ))}
            {draft && !draft.original && <li>{form}</li>}
          </ul>
        )}
      </section>

      {!draft && (
        full ? (
          <p className="px-1 pt-2 text-sm text-foreground/55">
            A site can have at most {MAX_VARIABLES} variables. Remove one to add another.
          </p>
        ) : (
          <Button
            variant="ghost"
            className="mt-1 h-12 justify-start gap-3 rounded-2xl px-5 text-base hover:bg-foreground/10"
            onClick={() => setDraft({ name: '', value: '' })}
          >
            <Plus aria-hidden="true" className="size-5" />
            Add variable
          </Button>
        )
      )}

      <p className="px-1 pt-2 text-sm text-foreground/45">
        Anything here can be read by the site and everything it loads, so keep secrets out.
      </p>
    </NsiteInfoPage>
  );
}
