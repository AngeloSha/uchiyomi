'use client';
// The one muted line under a series' title that says where its chapters come from, and opens the Sources &
// translations sheet. lib/supplyLine.ts decides what it says; this only draws it.
//
// One line, always: the button is `overflow-hidden` with `whitespace-nowrap`, and only two things may give,
// in this order -- the SOURCE name first (`min-w-0 truncate`, and `shrink-[4]` so it takes the deficit
// before the group name does), the group name second (`min-w-0 truncate`; the pure function has already
// dropped it when it could not fit whole). ⚠️ Never the count -- "4 not here yet" cut to "4 not h…" is the
// one fact the line exists to carry, and in the 0-book state ("8 chapters listed · none fetched yet") it
// is most of the line -- never the chevron, and never the whole button (a `truncate` on the flex container
// would clip nothing and overflow the page instead; at 390 px that was the 1-pixel horizontal scroll the
// layout check measures for). Measured before the source part could give: `Mangakakalot (Manganato)` as
// the source overflowed the button by 55 px in that state, the count cut mid-word and the chevron outside
// the button. The group segment is `overflow-hidden` while it has a name (its "+n" would otherwise paint
// over the count once the name is down to nothing) and `shrink-0` without one, since nothing in it gives.
//
// Mounted twice by the page -- `wide={false}` under the phone title block, `wide` as the first row of the
// desktop column -- each in a wrapper hidden by breakpoint (a `hidden`/`flex` pair on the button itself
// would fight over `display`), so the pure function chooses the form and CSS chooses the mount. A skeleton
// until the three queries behind it have settled, or the line rewrites itself three times while they arrive.
import { GroupAvatarStack } from '@/components/GroupAvatar';
import { SourceIcon } from '@/components/SourcePicker';
import { IcChevronRight } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { supplyText, type SupplyPart } from '@/lib/supplyLine';

export function SupplyLine({ parts, loaded, wide, onOpen }: {
  parts: SupplyPart[] | null;
  loaded: boolean;
  wide: boolean;
  onOpen: () => void;
}) {
  if (!loaded) return <div className="skeleton h-4 w-2/3 rounded" aria-hidden />;
  if (!parts) return null;
  // Which parts may give, per the rule above. A groups part with no name is all avatars and "+n".
  const give = (p: SupplyPart) =>
    p.kind === 'source' ? 'min-w-0 shrink-[4]'
    : p.kind === 'groups' && (wide || p.names.length > 0) ? 'min-w-0 overflow-hidden'
    : 'shrink-0';
  return (
    // The label is the line as text, since the avatars are `aria-hidden` and on a phone they may be the
    // only sign of the groups.
    <button type="button" onClick={onOpen} aria-haspopup="dialog" aria-label={supplyText(parts, tr, wide)}
      className="flex w-full items-center gap-1.5 overflow-hidden whitespace-nowrap text-start text-xs text-fog-400 hover:text-fog-200">
      {parts.map((p, i) => (
        <span key={i} className={`flex items-center gap-1.5 ${give(p)}`}>
          {i > 0 && <span aria-hidden className="text-ink-600">·</span>}
          {p.kind === 'source' && (
            <>
              <SourceIcon id={p.sourceId} name={p.name} size={16} registered={p.registered} />
              <span className={`min-w-0 truncate ${p.registered ? '' : 'text-fog-600'}`}>{p.name}</span>
            </>
          )}
          {p.kind === 'groups' && (wide
            ? <span className="min-w-0 truncate">{tr('Translated by {names}', { names: p.names.join(', ') + (p.more > 0 ? ` (+${p.more})` : '') })}</span>
            : <>
                <GroupAvatarStack names={p.all} size={16} />
                {p.names.length > 0 && <span className="min-w-0 truncate">{p.names[0]}</span>}
                {p.more > 0 && <span className="shrink-0">+{p.more}</span>}
              </>
          )}
          {p.kind === 'text' && <span>{tr(p.key, p.args)}</span>}
        </span>
      ))}
      <IcChevronRight width={14} height={14} className="ms-auto shrink-0 rtl:rotate-180" />
    </button>
  );
}
